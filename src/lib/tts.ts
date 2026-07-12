// Server-side text-to-speech + local playback of the result.
//
// Flow: chat reply text → tts-proxy edge function (holds the shared
// OPENAI_API_KEY, mirrors transcribe-proxy) → base64 mp3 → cache file →
// expo-audio player. Only one utterance plays at a time; starting a new one
// (or recording) stops the previous.
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { cacheDirectory, deleteAsync, EncodingType, writeAsStringAsync } from 'expo-file-system/legacy';
import { supabase } from './supabase';
import { stripForSpeech } from './tts-text';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const TTS_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/tts-proxy`;

export class TtsError extends Error {}

/** 429 fra proxyen — samme mønster som transskribering, bare kortere. */
function quotaMessage(retryAfterSec: number): string {
  if (retryAfterSec >= 90) return `Mange oplæsninger på kort tid — prøv igen om ${Math.ceil(retryAfterSec / 60)} minutter.`;
  if (retryAfterSec > 0) return `Mange oplæsninger på kort tid — prøv igen om ${Math.max(5, retryAfterSec)} sekunder.`;
  return 'Du har nået din grænse for nu. Prøv igen senere.';
}

/** Synthesize `text` via tts-proxy and write the mp3 to the cache dir.
 * Returns the local file URI. */
async function synthesizeToFile(text: string): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_ANON) throw new TtsError('Mangler Supabase-konfiguration.');
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new TtsError('Du skal være logget ind for at få læst op.');

  let res: Response;
  try {
    res = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON,
      },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new TtsError('Kunne ikke nå serveren. Tjek din forbindelse.');
  }
  if (res.status === 429) {
    let retryAfter = 0;
    try {
      retryAfter = Math.max(0, Number(((await res.json()) as { retry_after?: number }).retry_after ?? 0));
    } catch {
      // Uparselig krop → generisk besked.
    }
    throw new TtsError(quotaMessage(retryAfter));
  }
  if (!res.ok) throw new TtsError(`Oplæsningen fejlede (${res.status}).`);

  let audioB64: string;
  try {
    const parsed = (await res.json()) as { audio_b64?: string };
    if (!parsed.audio_b64) throw new Error('empty');
    audioB64 = parsed.audio_b64;
  } catch {
    throw new TtsError('Uventet svar fra serveren.');
  }
  if (!cacheDirectory) throw new TtsError('Ingen cache-mappe tilgængelig.');
  const uri = `${cacheDirectory}zolva-tts-${Date.now()}.mp3`;
  await writeAsStringAsync(uri, audioB64, { encoding: EncodingType.Base64 });
  return uri;
}

type CurrentPlayback = {
  player: AudioPlayer;
  uri: string;
  sub: { remove(): void };
  onEnd: () => void;
};

let current: CurrentPlayback | null = null;
// Bumped on every speak/stop so an in-flight synthesis knows it was superseded.
let generation = 0;

/** Stop any ongoing utterance and release its player + temp file. The
 * utterance's onEnd callback fires exactly once. Safe to call anytime. */
export function stopSpeaking(): void {
  generation++;
  const c = current;
  current = null;
  if (!c) return;
  c.sub.remove();
  try {
    c.player.pause();
  } catch {
    // player may already be released
  }
  try {
    c.player.remove();
  } catch {
    // ignore
  }
  deleteAsync(c.uri, { idempotent: true }).catch(() => {});
  c.onEnd();
}

/**
 * Read `text` aloud. Resolves when playback has STARTED; `onEnd` fires when
 * it finishes, is stopped, or is superseded by a newer speak(). Throws
 * TtsError if synthesis fails (in which case onEnd does NOT fire).
 */
export async function speak(text: string, onEnd: () => void): Promise<void> {
  stopSpeaking();
  const gen = generation;
  const clean = stripForSpeech(text);
  if (!clean) {
    onEnd();
    return;
  }
  const uri = await synthesizeToFile(clean);
  if (gen !== generation) {
    // A newer speak()/stopSpeaking() won the race while we were synthesizing.
    deleteAsync(uri, { idempotent: true }).catch(() => {});
    onEnd();
    return;
  }
  // Recording mode may still be active after a voice question — playback
  // needs it off, and silent-switch users still expect to hear the answer.
  await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  const player = createAudioPlayer(uri);
  const sub = player.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish) stopSpeaking();
  });
  current = { player, uri, sub, onEnd };
  player.play();
}
