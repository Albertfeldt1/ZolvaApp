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
  {
    name: 'mail_archive',
    description:
      'Archive a thread the user has clearly already handled (newsletters, receipts, automated notifications). Removes INBOX label only — recoverable.',
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
    name: 'mail_label',
    description:
      'Apply or remove a Gmail label on a thread. Use existing labels when present; create only short, clear category names like "Kvitteringer", "Nyhedsbreve", "Rejser".',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        label: { type: 'string' },
        op: { type: 'string', enum: ['add', 'remove'] },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['thread_id', 'label', 'op', 'provider'],
    },
  },
  {
    name: 'mail_flag_important',
    description:
      'Mark a thread as important (applies the "Zolva flaggede" label). Use sparingly: only when the message likely needs the user\'s attention today.',
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
];

const SYSTEM_PROMPT = `Du er Zolva — en personlig assistent der triage'r brugerens indbakke i baggrunden. Du kan udføre handlinger på både Gmail og Outlook (Microsoft).

Tilladte handlinger:
1. arkivere åbenlyst færdige tråde (kvitteringer, nyhedsbreve, automatiserede beskeder) — KUN Gmail. Spring over for Outlook-tråde.
2. tilføje en kort kategori-label — KUN Gmail. Spring over for Outlook-tråde.
3. markere en tråd som vigtig — KUN Gmail. Spring over for Outlook-tråde.
4. skrive en kort dansk opsummering (max 200 tegn) hvis emnet alene ikke siger hvad brugeren skal gøre.
5. RESEARCH-FØRST: hvis afsenderen er et menneske og emnet/snippet ANTYDER et spørgsmål, en tid, eller refererer til et dokument, SKAL du kalde mail_get_body FØRST for at læse hele beskeden. Derefter:
   a. hvis brevet spørger om tid eller tilgængelighed: kald cal_list_events med vinduet ±2 timer omkring den nævnte tid.
   b. hvis brevet nævner et dokument/proposal/kontrakt o.l.: kald drive_search med relevante nøgleord — KUN for Gmail-tråde (drive_search er ikke tilgængelig for Outlook).
   Først NÅR du har konteksten, kald mail_draft_reply.
6. udkast et reply (mail_draft_reply) — KUN når du har læst hele body'en med mail_get_body, brevet stiller et tydeligt spørgsmål, og du kan skrive et kort dansk svar uden at gætte.
7. foreslå at sende udkastet (mail_send_reply) umiddelbart efter mail_draft_reply, hvis svaret er entydigt OG du har researchet tråden i denne tur.

Regler:
- Brug kun thread_id'er fra listen i brugerens besked. Opfind ALDRIG ID'er.
- Hver tråd har en provider ('google' eller 'microsoft'). Du SKAL inkludere provider i payload til alle handlinger.
- For Outlook-tråde: kun mail_summarize, mail_get_body, cal_list_events, mail_draft_reply og mail_send_reply er tilgængelige. Forsøg ikke at arkivere/labelle/flagge Outlook-tråde — disse handlinger vil fejle.
- drive_search er KUN Google. Spring over hvis tråden er Outlook-only.
- Vær konservativ: hvis du er i tvivl efter research, gør ingenting.
- Du kan kalde flere værktøjer i samme tur. Stop når listen er triageret.
- Svar på dansk i den korte tekstkommentar efter værktøjskald.`;

export interface BuildMailTriagePromptInput {
  threads: ThreadBrief[];
}

export interface BuildMailTriagePromptResult {
  system: ClaudeSystemBlock[];
  messages: ClaudeUserMessage[];
}

export function buildMailTriagePrompt(
  input: BuildMailTriagePromptInput,
): BuildMailTriagePromptResult {
  const system: ClaudeSystemBlock[] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  const body = input.threads.length === 0
    ? 'Ingen nye tråde. Returnér en kort tekstbekræftelse uden værktøjskald.'
    : [
        'Triager følgende tråde:',
        '',
        ...input.threads.map((t) =>
          `- thread_id=${t.thread_id} | provider=${t.provider ?? 'google'} | from=${t.from} | subject=${t.subject}${t.snippet ? ` | snippet=${t.snippet.slice(0, 120)}` : ''}`,
        ),
      ].join('\n');
  const messages: ClaudeUserMessage[] = [{ role: 'user', content: body }];
  return { system, messages };
}
