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

export interface BuildMailNewEventsInput {
  userId: string;
  provider: 'google' | 'microsoft';
  messages: PollMailMessage[];
}

export interface MailNewEventRow {
  user_id: string;
  kind: 'mail.new';
  payload: {
    provider: 'google';
    message_id: string;
    thread_id: string | null;
    from: string;
    subject: string;
    idem_key: string;
  };
}

// Phase 2 only emits events for google watchers. Microsoft + iCloud
// follow in 2.1 when the matching tool implementations land.
export function buildMailNewEventRows(
  input: BuildMailNewEventsInput,
): MailNewEventRow[] {
  if (input.provider !== 'google') return [];
  return input.messages.map((m) => ({
    user_id: input.userId,
    kind: 'mail.new',
    payload: {
      provider: 'google',
      message_id: m.messageId,
      thread_id: m.threadId ?? null,
      from: m.from,
      subject: m.subject,
      idem_key: `google:${m.messageId}`,
    },
  }));
}
