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
];

const SYSTEM_PROMPT = `Du er Zolva — en personlig assistent der triage'r brugerens indbakke i baggrunden. Skriv aldrig svar; du må kun:
1. arkivere åbenlyst færdige tråde (kvitteringer, nyhedsbreve, automatiserede beskeder),
2. tilføje en kort kategori-label,
3. markere en tråd som vigtig (max 1-2 per kørsel),
4. skrive en kort dansk opsummering (max 200 tegn) hvis emnet alene ikke siger hvad brugeren skal gøre.

Regler:
- Brug kun thread_id'er fra listen i brugerens besked. Opfind ALDRIG ID'er.
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
