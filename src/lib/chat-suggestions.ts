import { completeJson } from './claude';

export const STATIC_CHAT_SUGGESTIONS: readonly string[] = [
  'Mine påmindelser',
  'Husk at ringe i morgen',
  'Skriv en note',
  'Hvad har jeg noteret?',
];

export const CHAT_SUGGESTION_COUNT = 4;
const MAX_DYNAMIC = 4;
const MAX_TEXT_LEN = 120;

export type MailForSuggestion = {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  isRead: boolean;
};

const SYSTEM_PROMPT =
  'Du er Zolva. Brugeren har netop åbnet chatten. Ud fra listen over nylige mails, ' +
  'foreslå korte chat-prompts som brugeren kunne trykke på for at bede dig om hjælp — ' +
  'typisk en påmindelse eller en note. Hvis en mail beder brugeren om at huske noget, ' +
  'forslå "Husk mig på at …". Hvis en mail nævner en deadline eller aftale, forslå en ' +
  'relevant påmindelse. Returnér 0–4 prompts, sorteret efter vigtighed — de vigtigste først. ' +
  'Hver prompt er maks 12 ord, skrevet på dansk, formuleret som noget brugeren ville sige til dig. ' +
  'Hvis ingen mails har noget handlingsrettet, returnér en tom liste.';

const SCHEMA_HINT = '[{"text": string}]';

function formatMailList(mails: MailForSuggestion[]): string {
  const lines = mails.map((m) => `- ${m.from}: ${m.subject}`);
  return `Nylige mails:\n${lines.join('\n')}`;
}

function sanitize(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_TEXT_LEN) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_DYNAMIC) break;
  }
  return out;
}

export async function extractChatSuggestions(
  mails: MailForSuggestion[],
  signal: AbortSignal,
): Promise<string[]> {
  if (mails.length === 0) return [];
  const raw = await completeJson<unknown>({
    signal,
    system: SYSTEM_PROMPT,
    schemaHint: SCHEMA_HINT,
    messages: [{ role: 'user', content: formatMailList(mails) }],
    maxTokens: 256,
    temperature: 0.4,
  });
  return sanitize(raw);
}

export function padSuggestions(dynamic: string[]): string[] {
  const out = [...dynamic];
  const seen = new Set(out.map((s) => s.trim().toLowerCase()));
  for (const s of STATIC_CHAT_SUGGESTIONS) {
    if (out.length >= CHAT_SUGGESTION_COUNT) break;
    const key = s.trim().toLowerCase();
    if (seen.has(key)) continue;
    out.push(s);
    seen.add(key);
  }
  return out.slice(0, CHAT_SUGGESTION_COUNT);
}
