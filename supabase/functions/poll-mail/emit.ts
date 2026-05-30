// supabase/functions/poll-mail/emit.ts
//
// Pure helpers for emitting `mail.new` agent_events from poll-mail.
// The DB insert lives in index.ts; this file is intentionally side-effect-free
// so it can be unit-tested without a Supabase client.

export interface PollMailMessage {
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
}

// True only for genuinely-received inbox mail. Gmail's history API
// (historyTypes=messageAdded) is mailbox-wide, so it also reports the agent's
// OWN drafts (DRAFT label) and auto-sends (SENT label) as "added" — emitting a
// mail.new for those re-triggers the agent on a thread it just acted on, an
// infinite draft→event→draft loop. Require INBOX and exclude DRAFT/SENT.
// Missing labels → reject (can't confirm inbound; safer than looping).
export function isInboundGmailMessage(labelIds: string[] | undefined): boolean {
  if (!labelIds || labelIds.length === 0) return false;
  if (labelIds.includes('DRAFT') || labelIds.includes('SENT')) return false;
  return labelIds.includes('INBOX');
}

export interface BuildMailNewEventsInput {
  userId: string;
  provider: 'google' | 'microsoft';
  messages: PollMailMessage[];
}

export interface MailNewEventRow {
  user_id: string;
  kind: 'mail.new';
  payload: {
    provider: 'google' | 'microsoft';
    message_id: string;
    thread_id: string | null;
    from: string;
    subject: string;
    idem_key: string;
  };
}

// Phase 3 emits for both google and microsoft. iCloud follows when its
// tool implementations land (Phase 3.2+).
export function buildMailNewEventRows(
  input: BuildMailNewEventsInput,
): MailNewEventRow[] {
  if (input.provider !== 'google' && input.provider !== 'microsoft') return [];
  return input.messages.map((m) => ({
    user_id: input.userId,
    kind: 'mail.new',
    payload: {
      provider: input.provider,
      message_id: m.messageId,
      thread_id: m.threadId ?? null,
      from: m.from,
      subject: m.subject,
      idem_key: `${input.provider}:${m.messageId}`,
    },
  }));
}
