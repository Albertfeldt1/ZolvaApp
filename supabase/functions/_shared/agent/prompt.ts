// supabase/functions/_shared/agent/prompt.ts
import type { ClaudeSystemBlock, ClaudeUserMessage } from './claude.ts';

export interface ThreadBrief {
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
}

export const MAIL_TRIAGE_TOOLS: ReadonlyArray<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> = [
  {
    name: 'mail.archive',
    description:
      'Archive a thread the user has clearly already handled (newsletters, receipts, automated notifications). Removes INBOX label only — recoverable.',
    input_schema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
    },
  },
  {
    name: 'mail.label',
    description:
      'Apply or remove a Gmail label on a thread. Use existing labels when present; create only short, clear category names like "Kvitteringer", "Nyhedsbreve", "Rejser".',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        label: { type: 'string' },
        op: { type: 'string', enum: ['add', 'remove'] },
      },
      required: ['thread_id', 'label', 'op'],
    },
  },
  {
    name: 'mail.flag_important',
    description:
      'Mark a thread as important (applies the "Zolva flaggede" label). Use sparingly: only when the message likely needs the user\'s attention today.',
    input_schema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
    },
  },
  {
    name: 'mail.summarize',
    description:
      'Write a one- to two-sentence Danish summary of the thread. Use when the subject alone does not convey what action (if any) the user needs to take. Summary must be ≤ 200 chars.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        summary: { type: 'string', maxLength: 200 },
      },
      required: ['thread_id', 'summary'],
    },
  },
  {
    name: 'mail.draft_reply',
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
      },
      required: ['thread_id', 'in_reply_to_message_id', 'body'],
    },
  },
  {
    name: 'mail.send_reply',
    description:
      'Propose to send the draft you just created. Always requires user approval — this writes a pending proposal, not an actual send. Use right after mail.draft_reply for the same thread when the reply is unambiguous.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        draft_id: { type: 'string', description: 'returned by mail.draft_reply (or known existing draft)' },
        draft_hash: { type: 'string', description: 'sha1 of the body — used for idempotency' },
        preview_text: { type: 'string', description: 'one-line preview for the proposal card, ≤ 120 chars' },
      },
      required: ['thread_id', 'draft_id', 'draft_hash', 'preview_text'],
    },
  },
];

const SYSTEM_PROMPT = `Du er Zolva — en personlig assistent der triage'r brugerens indbakke i baggrunden. Du kan udføre handlinger på både Gmail og Outlook (Microsoft).

Tilladte handlinger:
1. arkivere åbenlyst færdige tråde (kvitteringer, nyhedsbreve, automatiserede beskeder) — KUN Gmail. Spring over for Outlook-tråde.
2. tilføje en kort kategori-label — KUN Gmail. Spring over for Outlook-tråde.
3. markere en tråd som vigtig — KUN Gmail. Spring over for Outlook-tråde.
4. skrive en kort dansk opsummering (max 200 tegn) hvis emnet alene ikke siger hvad brugeren skal gøre.
5. udkast et reply (mail.draft_reply) — KUN når afsenderen er et menneske (ikke noreply@/notifications@/etc.), brevet stiller et tydeligt spørgsmål eller forventer et svar, og du kan skrive et kort dansk svar uden at gætte. Hold dig forsigtig; brugeren retter inden afsendelse.
6. foreslå at sende udkastet (mail.send_reply) umiddelbart efter mail.draft_reply, hvis svaret er entydigt. Send kræver altid brugerens godkendelse.

Regler:
- Brug kun thread_id'er fra listen i brugerens besked. Opfind ALDRIG ID'er.
- Hver tråd har en provider ('google' eller 'microsoft'). Du SKAL inkludere provider i payload til alle handlinger.
- For Outlook-tråde: kun mail.summarize, mail.draft_reply og mail.send_reply er tilgængelige. Forsøg ikke at arkivere/labelle/flagge Outlook-tråde — disse handlinger vil fejle.
- Vær konservativ: hvis du er i tvivl, gør ingenting.
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
          `- thread_id=${t.thread_id} | from=${t.from} | subject=${t.subject}${t.snippet ? ` | snippet=${t.snippet.slice(0, 120)}` : ''}`,
        ),
      ].join('\n');
  const messages: ClaudeUserMessage[] = [{ role: 'user', content: body }];
  return { system, messages };
}
