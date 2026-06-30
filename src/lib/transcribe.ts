// Server-side voice transcription + action extraction.
//
// Flow: record audio (expo-audio) → upload the file to the transcribe-proxy
// edge function (which holds the shared OPENAI_API_KEY) → get the Danish
// transcript → Claude extracts structured actions (reminders / events) from it.
//
// The OpenAI key NEVER lives in the app — only in the edge function, exactly
// like ANTHROPIC_API_KEY behind claude-proxy.
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import { supabase } from './supabase';
import { completeJson } from './claude';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const TRANSCRIBE_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/transcribe-proxy`;

export class TranscribeError extends Error {}

/**
 * Upload a recorded audio file to the transcribe-proxy and return the Danish
 * transcript. `uri` is the local file URI from expo-audio's recorder.
 */
export async function transcribeAudio(uri: string): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    throw new TranscribeError('Mangler Supabase-konfiguration.');
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new TranscribeError('Du skal være logget ind for at transskribere.');
  }

  // Use expo-file-system's native multipart upload — far more reliable on iOS
  // than fetch + FormData with a file part (which dropped uploads intermittently).
  let res: { status: number; body: string };
  try {
    res = await uploadAsync(TRANSCRIBE_URL, uri, {
      httpMethod: 'POST',
      uploadType: FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType: 'audio/m4a',
      parameters: { language: 'da' },
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON,
      },
    });
  } catch {
    throw new TranscribeError('Kunne ikke nå serveren. Tjek din forbindelse.');
  }

  if (res.status === 429) {
    throw new TranscribeError('Du har nået din grænse for nu. Prøv igen senere.');
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
  | { kind: 'reminder'; title: string; time?: string }
  | { kind: 'event'; title: string; time?: string; place?: string };

type ExtractionResult = { title: string; actions: ExtractedAction[] };

const EXTRACT_SYSTEM = `Du analyserer en transskriberet dansk stemme-note fra en lille virksomhedsejer. Find konkrete handlinger personen vil gøre: påmindelser og kalender-begivenheder.

- Giv noten en kort, naturlig dansk titel (3-6 ord).
- For hver handling: en kort dansk titel, og hvis nævnt, et tidspunkt ("13.55", "i morgen", "før fredag") og evt. et sted.
- Medtag KUN handlinger der tydeligt er udtrykt. Opfind intet. Hvis ingen, returnér en tom liste.`;

const EXTRACT_SCHEMA = `{
  "title": string,
  "actions": Array<
    | { "kind": "reminder", "title": string, "time"?: string }
    | { "kind": "event", "title": string, "time"?: string, "place"?: string }
  >
}`;

/** Extract a title + structured actions from a transcript via Claude (Haiku). */
export async function extractActions(transcript: string): Promise<ExtractionResult> {
  const text = transcript.trim();
  if (!text) return { title: 'Tom optagelse', actions: [] };
  try {
    const result = await completeJson<ExtractionResult>({
      system: EXTRACT_SYSTEM,
      schemaHint: EXTRACT_SCHEMA,
      messages: [{ role: 'user', content: text }],
      maxTokens: 512,
      attachProfile: false,
    });
    return {
      title: result.title?.trim() || 'Ny optagelse',
      actions: Array.isArray(result.actions) ? result.actions : [],
    };
  } catch {
    // Transcript is still useful even if extraction fails — return it titled.
    return { title: 'Ny optagelse', actions: [] };
  }
}
