// Server-side voice transcription + action extraction.
//
// Flow: record audio (expo-audio) → upload the file to the transcribe-proxy
// edge function (which holds the shared OPENAI_API_KEY) → get the Danish
// transcript → Claude extracts structured actions (reminders / events) from it.
//
// The OpenAI key NEVER lives in the app — only in the edge function, exactly
// like ANTHROPIC_API_KEY behind claude-proxy.
import { getInfoAsync, createUploadTask, FileSystemUploadType } from 'expo-file-system/legacy';
import { supabase } from './supabase';
import { completeJson } from './claude';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const TRANSCRIBE_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/transcribe-proxy`;

export class TranscribeError extends Error {}
/** Kastet når kalderen afbryder (Kassér/back) — behandles som stilhed, ikke fejl. */
export class TranscribeCancelled extends TranscribeError {}

/** 429 fra proxyen bærer `retry_after` (sek.) og årsag ("rate_limit_daily" /
 * "rate_limit_rpm") — vis hvornår der kan prøves igen i stedet for et vagt
 * "senere", og hint til Pro ved det daglige loft (L7). */
function quotaMessage(body: string): string {
  let retryAfterSec = 0;
  let reason = '';
  try {
    const parsed = JSON.parse(body) as { retry_after?: number; error?: string };
    retryAfterSec = Math.max(0, Number(parsed.retry_after ?? 0));
    reason = String(parsed.error ?? '');
  } catch {
    // Uparselig krop → generisk besked nedenfor.
  }
  if (reason.includes('daily')) {
    const reset = new Date(Date.now() + retryAfterSec * 1000);
    const clock = `${String(reset.getHours()).padStart(2, '0')}.${String(reset.getMinutes()).padStart(2, '0')}`;
    const when = retryAfterSec > 0 ? ` Grænsen nulstilles kl. ${clock}.` : ' Grænsen nulstilles ved midnat.';
    return `Du har nået dagens grænse for transskribering.${when} Zolva Pro giver et højere dagligt loft.`;
  }
  if (retryAfterSec > 0) {
    const wait =
      retryAfterSec >= 90 ? `${Math.ceil(retryAfterSec / 60)} minutter` : `${Math.max(5, retryAfterSec)} sekunder`;
    return `Mange optagelser på kort tid — prøv igen om ${wait}.`;
  }
  return 'Du har nået din grænse for nu. Prøv igen senere.';
}

// Upload timeout: the legacy uploadAsync API has no abort signal, so a race
// is the only way to stop the UI from hanging forever (M82). A FIXED 60s was
// too aggressive (QA K3): a 10-min take (~10 MB) on slow mobile data needs
// several minutes and would fail on every retry. Scale with file size at a
// pessimistic ~40 KB/s floor, min 60s, capped at 6 minutes.
const UPLOAD_MIN_TIMEOUT_MS = 60_000;
const UPLOAD_MAX_TIMEOUT_MS = 360_000;
const UPLOAD_WORST_BYTES_PER_SEC = 40_000;

async function uploadTimeoutFor(uri: string): Promise<number> {
  try {
    const info = await getInfoAsync(uri);
    const size = info.exists && typeof info.size === 'number' ? info.size : 0;
    if (size <= 0) return UPLOAD_MIN_TIMEOUT_MS;
    const scaled = (size / UPLOAD_WORST_BYTES_PER_SEC) * 1000 + 15_000;
    return Math.min(UPLOAD_MAX_TIMEOUT_MS, Math.max(UPLOAD_MIN_TIMEOUT_MS, Math.round(scaled)));
  } catch {
    return UPLOAD_MIN_TIMEOUT_MS;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  m4a: 'audio/m4a',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  caf: 'audio/x-caf',
  '3gp': 'audio/3gpp',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
};

/** expo-audio's output container differs per platform/preset — derive the
 * mimetype from the file extension instead of hardcoding m4a (L67). */
function mimeTypeFor(uri: string): string {
  const ext = uri.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'audio/m4a';
}

/**
 * Upload a recorded audio file to the transcribe-proxy and return the Danish
 * transcript. `uri` is the local file URI from expo-audio's recorder.
 * `signal` (M1): afbryder den native upload — uden den fortsatte uploaden i
 * baggrunden efter Kassér og forbrændte transskriberings-kvote.
 */
export async function transcribeAudio(uri: string, signal?: AbortSignal): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    throw new TranscribeError('Mangler Supabase-konfiguration.');
  }
  if (signal?.aborted) throw new TranscribeCancelled('Annulleret.');
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new TranscribeError('Du skal være logget ind for at transskribere.');
  }
  if (signal?.aborted) throw new TranscribeCancelled('Annulleret.');

  // Use expo-file-system's native multipart upload — far more reliable on iOS
  // than fetch + FormData with a file part (which dropped uploads intermittently).
  // createUploadTask = samme native sti som uploadAsync, men med cancelAsync,
  // så både Kassér (signal) og timeout faktisk stopper uploaden (M1/M82).
  const task = createUploadTask(TRANSCRIBE_URL, uri, {
    httpMethod: 'POST',
    uploadType: FileSystemUploadType.MULTIPART,
    fieldName: 'file',
    mimeType: mimeTypeFor(uri),
    parameters: { language: 'da' },
    headers: {
      authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON,
    },
  });
  const onAbort = () => {
    void task.cancelAsync().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  // cancelAsync løser uploadAsync med null/undefined — normalisér til Cancelled.
  let res: { status: number; body: string } | null | undefined;
  try {
    const timeoutMs = await uploadTimeoutFor(uri);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new TranscribeError('Transskriberingen tog for lang tid. Prøv igen.')), timeoutMs);
    });
    res = await Promise.race([task.uploadAsync(), timeout]);
  } catch (e) {
    if (signal?.aborted) throw new TranscribeCancelled('Annulleret.');
    onAbort(); // timeout/netværksfejl: stop den native upload i stedet for at lade den løbe
    if (e instanceof TranscribeError) throw e;
    throw new TranscribeError('Kunne ikke nå serveren. Tjek din forbindelse.');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (!res || signal?.aborted) throw new TranscribeCancelled('Annulleret.');

  if (res.status === 429) {
    throw new TranscribeError(quotaMessage(res.body));
  }
  if (res.status < 200 || res.status >= 300) {
    console.warn(`[voice] proxy ${res.status}: ${(res.body ?? '').slice(0, 300)}`);
    throw new TranscribeError(`Transskriberingen fejlede (${res.status}).`);
  }
  let parsed: { text?: string };
  try {
    parsed = JSON.parse(res.body) as { text?: string };
  } catch {
    throw new TranscribeError('Uventet svar fra serveren.');
  }
  return (parsed.text ?? '').trim();
}

export type ExtractedAction =
  | { kind: 'reminder'; title: string; time?: string; whenISO?: string }
  | { kind: 'event'; title: string; time?: string; place?: string; whenISO?: string; endISO?: string };

type ExtractionResult = { title: string; actions: ExtractedAction[]; isQuestion: boolean };

// The model resolves relative Danish time expressions ("i morgen kl 10",
// "på fredag") against the CURRENT local datetime injected below — parsing
// those client-side is strictly worse. `time` stays as the display string
// the user actually said; `whenISO` is the machine-usable resolution.
function buildExtractSystem(now: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Copenhagen';
  const local = now.toLocaleString('da-DK', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Du analyserer en transskriberet dansk stemme-note fra en lille virksomhedsejer. Find konkrete handlinger personen vil gøre: påmindelser og kalender-begivenheder.

Lige nu er klokken: ${local} (tidszone ${tz}).

- Giv noten en kort, naturlig dansk titel (3-6 ord).
- For hver handling: en kort dansk titel, og hvis nævnt, et tidspunkt som personen sagde det ("13.55", "i morgen", "før fredag") og evt. et sted.
- Når et tidspunkt kan opløses til en konkret dato/tid, sæt "whenISO" til en ISO 8601-dato-tid MED tidszone-offset (fx "2026-07-06T10:00:00+02:00"), opløst relativt til klokken lige nu. For begivenheder med kendt sluttid: sæt også "endISO". Er tidspunktet for vagt ("snart", "en dag"), udelad whenISO.
- Medtag KUN handlinger der tydeligt er udtrykt. Opfind intet. Hvis ingen, returnér en tom liste.
- Sæt "question" til true KUN hvis personen primært henvender sig til en assistent med et spørgsmål eller en anmodning om information/et svar (fx "hvad har jeg i kalenderen i morgen?", "har jeg fået svar fra Mette?", "opsummér mine mails"). Dikterer personen en note, en tanke eller handlinger, er "question" false.`;
}

const EXTRACT_SCHEMA = `{
  "title": string,
  "question": boolean,
  "actions": Array<
    | { "kind": "reminder", "title": string, "time"?: string, "whenISO"?: string }
    | { "kind": "event", "title": string, "time"?: string, "place"?: string, "whenISO"?: string, "endISO"?: string }
  >
}`;

/** Extract a title + structured actions from a transcript via Claude (Haiku). */
export async function extractActions(transcript: string): Promise<ExtractionResult> {
  const text = transcript.trim();
  if (!text) return { title: 'Tom optagelse', actions: [], isQuestion: false };
  try {
    const result = await completeJson<{ title?: string; question?: boolean; actions?: ExtractedAction[] }>({
      system: buildExtractSystem(new Date()),
      schemaHint: EXTRACT_SCHEMA,
      messages: [{ role: 'user', content: text }],
      maxTokens: 512,
      attachProfile: false,
    });
    return {
      title: result.title?.trim() || 'Ny optagelse',
      actions: Array.isArray(result.actions) ? result.actions : [],
      isQuestion: result.question === true,
    };
  } catch {
    // Transcript is still useful even if extraction fails — return it titled.
    return { title: 'Ny optagelse', actions: [], isQuestion: false };
  }
}
