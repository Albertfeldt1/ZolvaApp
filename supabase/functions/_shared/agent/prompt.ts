// supabase/functions/_shared/agent/prompt.ts
import type { ClaudeSystemBlock, ClaudeUserMessage } from './claude.ts';
import type { ActionType } from './types.ts';

// Anthropic's tools API requires names to match ^[a-zA-Z0-9_-]{1,128}$ —
// no dots. Internally we use dotted action types (e.g. 'mail.archive')
// because those flow through the DB (action_type column, policy keys).
// This map translates the Claude-facing underscore form back to the
// canonical dotted form at the runner boundary.
const TOOL_NAME_TO_ACTION: Record<string, ActionType> = {
  mail_archive: 'mail.archive',
  mail_label: 'mail.label',
  mail_flag_important: 'mail.flag_important',
  mail_summarize: 'mail.summarize',
  mail_draft_reply: 'mail.draft_reply',
  mail_send_reply: 'mail.send_reply',
  mail_get_body: 'mail.get_body',
  cal_list_events: 'cal.list_events',
  drive_search: 'drive.search',
  cal_create_event: 'cal.create_event',
  cal_update_event: 'cal.update_event',
};

export function actionTypeFromToolName(name: string): ActionType | null {
  return TOOL_NAME_TO_ACTION[name] ?? null;
}

export interface ThreadBrief {
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
  // Which mailbox the thread lives in. Every tool payload must carry this, so
  // it has to be visible in the brief — Claude was previously left to guess it
  // from the sender domain, which fails for Outlook and isn't reliable anyway.
  provider?: 'google' | 'microsoft';
}

export const MAIL_TRIAGE_TOOLS: ReadonlyArray<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> = [
  // mail_archive / mail_label / mail_flag_important were removed 2026-05-30:
  // they require the gmail.modify scope, which is intentionally NOT granted, so
  // every call returned 403 and wasted tool rounds + budget. Re-add them only
  // if gmail.modify is added to the consent scope set. The dispatch/idem/policy
  // code for them still exists, harmlessly, behind the now-absent tool.
  {
    name: 'mail_summarize',
    description:
      'Write a one- to two-sentence Danish summary of the thread. Use when the subject alone does not convey what action (if any) the user needs to take. Summary must be ≤ 200 chars.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        summary: { type: 'string', maxLength: 200 },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['thread_id', 'summary', 'provider'],
    },
  },
  {
    name: 'mail_draft_reply',
    description:
      'Create a draft reply (visible in the user\'s Drafts folder, NOT sent). Use only for direct messages from a human where a reply is clearly expected — never for newsletters, automated mail, or threads where you cannot tell what to say. Keep replies short and conservative; the user will edit before sending. Both providers supported.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        in_reply_to_message_id: { type: 'string' },
        to: { type: 'string', description: 'recipient address (Gmail only; Outlook draft is pre-filled by createReply)' },
        subject: { type: 'string', description: 'Gmail only' },
        body: { type: 'string', description: 'Danish, ≤ 600 chars' },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['thread_id', 'in_reply_to_message_id', 'body', 'provider'],
    },
  },
  {
    name: 'mail_send_reply',
    description:
      'Finalise the draft you just created. Default behaviour is to propose (user approves on Today). When the user\'s policy is auto AND safety rails clear (idle, recipient known, no prior failure), this sends without user confirmation. Use right after mail_draft_reply for the same thread when the reply is unambiguous.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        draft_id: { type: 'string', description: 'returned by mail_draft_reply (or known existing draft)' },
        draft_hash: { type: 'string', description: 'sha1 of the body — used for idempotency' },
        preview_text: { type: 'string', description: 'one-line preview for the proposal card, ≤ 120 chars' },
        to: { type: 'string', description: 'recipient email address — must equal the to used in the prior mail_draft_reply step' },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['thread_id', 'draft_id', 'draft_hash', 'preview_text', 'to', 'provider'],
    },
  },
  {
    name: 'mail_get_body',
    description:
      'Read the full text of the latest message in a thread. Call this BEFORE mail_draft_reply on any thread that asks a question, references a meeting time, or mentions a document. The body is what tells you what to answer.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['thread_id', 'provider'],
    },
  },
  {
    name: 'cal_list_events',
    description:
      'Return the user\'s calendar events in a time window. Use BEFORE drafting any reply about availability, scheduling, or "are you free at X?". Pass start_iso/end_iso as ISO-8601 with timezone. Window should bracket the asked time by at least ±2 hours.',
    input_schema: {
      type: 'object',
      properties: {
        start_iso: { type: 'string' },
        end_iso: { type: 'string' },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['start_iso', 'end_iso', 'provider'],
    },
  },
  {
    name: 'drive_search',
    description:
      'Search the user\'s Google Drive by name + full-text. Use when a mail references a document (e.g. "did you see the proposal?", "the contract I sent"). Phase 4a is Google-only — skip for Outlook-only threads.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        provider: { type: 'string', enum: ['google'] },
      },
      required: ['query', 'provider'],
    },
  },
  {
    name: 'cal_create_event',
    description:
      'Create a calendar event. Use only when a human thread proposes a concrete date+time. Provide start_iso/end_iso as UTC ISO-8601 ending in Z. The event is proposed to the user for approval before it is created. Both providers.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start_iso: { type: 'string', description: 'UTC ISO-8601, ends with Z' },
        end_iso: { type: 'string', description: 'UTC ISO-8601, ends with Z' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'attendee email addresses' },
        location: { type: 'string' },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['title', 'start_iso', 'end_iso', 'provider'],
    },
  },
  {
    name: 'cal_update_event',
    description:
      'Change an existing calendar event\'s time, title, or location. event_id MUST come from a prior cal_list_events result — never invent it. Provide new times as UTC ISO-8601 ending in Z. Proposed to the user for approval. Both providers.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'from cal_list_events — never invented' },
        title: { type: 'string' },
        start_iso: { type: 'string', description: 'UTC ISO-8601, ends with Z' },
        end_iso: { type: 'string', description: 'UTC ISO-8601, ends with Z' },
        location: { type: 'string' },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['event_id', 'provider'],
    },
  },
];

const SYSTEM_PROMPT = `Du er Zolva — en personlig assistent der triage'r brugerens indbakke i baggrunden. Du kan udføre handlinger på både Gmail og Outlook (Microsoft).

Tilladte handlinger:
1. skrive en kort dansk opsummering (mail_summarize, max 200 tegn) hvis emnet alene ikke siger hvad brugeren skal gøre.
2. RESEARCH-FØRST: hvis afsenderen er et menneske og emnet/snippet ANTYDER et spørgsmål, en tid, eller refererer til et dokument, SKAL du kalde mail_get_body FØRST for at læse hele beskeden. Derefter:
   a. hvis brevet spørger om tid eller tilgængelighed: kald cal_list_events med vinduet ±2 timer omkring den nævnte tid.
   b. hvis brevet nævner et dokument/proposal/kontrakt o.l.: kald drive_search med relevante nøgleord — KUN for Gmail-tråde (drive_search er ikke tilgængelig for Outlook).
   Først NÅR du har konteksten, kald mail_draft_reply.
3. udkast et reply (mail_draft_reply) — KUN når du har læst hele body'en med mail_get_body, brevet stiller et tydeligt spørgsmål, og du kan skrive et kort dansk svar uden at gætte.
4. foreslå svaret (mail_send_reply): NÅR du har kaldt mail_draft_reply, SKAL du ALTID derefter kalde mail_send_reply i SAMME tur — med præcis det draft_id og draft_hash som mail_draft_reply returnerede. Det er mail_send_reply der viser forslaget til brugeren; et udkast uden et efterfølgende mail_send_reply når ALDRIG frem til brugeren. Spring det aldrig over.
5. KALENDER: hvis en menneskelig tråd foreslår et konkret mødetidspunkt, kald cal_list_events (±2 timer omkring tidspunktet) for at tjekke for konflikter. Hvis tidspunktet er ledigt, SKAL du derefter kalde cal_create_event med UTC ISO-8601 tider (slut med Z) — det er en obligatorisk del af at triagere en mødeinvitation, ud over at udkaste et svar. Spring ALDRIG kalenderbegivenheden over når et konkret tidspunkt er foreslået og ledigt; et svar alene er ikke nok. Hvis tråden beder om at flytte/ændre et eksisterende møde, find begivenheden via cal_list_events og kald cal_update_event med dens event_id. Alle kalenderhandlinger foreslås til brugeren, før de udføres. Brug KUN cal_create_event når brevet foreslår et konkret tidspunkt der skal sættes i kalenderen; hvis brevet blot spørger om din tilgængelighed, hører det under punkt 2a og besvares med mail_draft_reply (ikke en kalenderbegivenhed).

Regler:
- Brug kun thread_id'er fra listen i brugerens besked. Opfind ALDRIG ID'er. Brug draft_id og draft_hash præcis som mail_draft_reply returnerede dem — opfind dem ALDRIG.
- Hver tråd har en provider ('google' eller 'microsoft') i listen. Du SKAL inkludere provider i payload til alle handlinger.
- drive_search er KUN Google. Spring over hvis tråden er Outlook.
- event_id til cal_update_event SKAL komme fra cal_list_events — opfind ALDRIG et event_id. Brug UTC (Z-suffiks) for alle tider i kalenderhandlinger.
- DATO: Brug 'Dags dato' fra brugerens besked til at udregne korrekt årstal og ugedag i ALLE kalenderhandlinger (cal_list_events, cal_create_event, cal_update_event). Gæt eller opfind ALDRIG et årstal. F.eks.: hvis dags dato er i 2026 og brevet siger "torsdag den 5. juni", så er året 2026 — ikke 2025.
- Hvis en tråd ikke kræver et svar (ren bekræftelse, automatisk besked, nyhedsbrev), så gør ingenting på den tråd.
- Vær konservativ ved tvivl om INDHOLDET — men når et menneske stiller et tydeligt spørgsmål du kan svare på, SKAL du udkaste OG foreslå et svar. Lad være med at gøre ingenting af forsigtighed alene.
- Du kan kalde flere værktøjer i samme tur. Stop når listen er triageret.
- Svar på dansk i den korte tekstkommentar efter værktøjskald.`;

export interface BuildMailTriagePromptInput {
  threads: ThreadBrief[];
  // ISO-8601 instant for "now". Surfaced to the model as a Danish "Dags dato"
  // line so calendar date math (especially the year) is anchored instead of
  // guessed. Optional so tests/callers without a clock stay deterministic.
  nowIso?: string;
}

export interface BuildMailTriagePromptResult {
  system: ClaudeSystemBlock[];
  messages: ClaudeUserMessage[];
}

// "fredag den 30. maj 2026" — anchored to Copenhagen so weekday/date match the
// user's local sense of "torsdag den 5. juni".
function formatDanishDate(iso: string): string {
  return new Intl.DateTimeFormat('da-DK', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Copenhagen',
  }).format(new Date(iso));
}

export function buildMailTriagePrompt(
  input: BuildMailTriagePromptInput,
): BuildMailTriagePromptResult {
  const system: ClaudeSystemBlock[] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  // Per-run date line lives in the user message (not the cached system block)
  // so it never busts the ephemeral prompt cache.
  const dateLine = input.nowIso
    ? `Dags dato: ${formatDanishDate(input.nowIso)} (tidszone Europe/Copenhagen). Brug denne til at udregne korrekt årstal og ugedag i kalenderhandlinger.`
    : '';
  const body = input.threads.length === 0
    ? 'Ingen nye tråde. Returnér en kort tekstbekræftelse uden værktøjskald.'
    : [
        ...(dateLine ? [dateLine, ''] : []),
        'Triager følgende tråde:',
        '',
        ...input.threads.map((t) =>
          `- thread_id=${t.thread_id} | provider=${t.provider ?? 'google'} | from=${t.from} | subject=${t.subject}${t.snippet ? ` | snippet=${t.snippet.slice(0, 120)}` : ''}`,
        ),
      ].join('\n');
  const messages: ClaudeUserMessage[] = [{ role: 'user', content: body }];
  return { system, messages };
}
