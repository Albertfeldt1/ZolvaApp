import type { StoneMood } from '../components/Stone';

export type Tone = 'sage' | 'clay' | 'mist' | 'warning';

export type UserProfile = {
  name: string;
  email: string;
};

export type Subscription = {
  priceKr: number;
  plan: string;
  renewalDate: string;
};

export type ObservationAction =
  | { kind: 'chat' }
  | { kind: 'prompt'; prompt: string }
  | { kind: 'openMail'; mailId: string }
  // Open the mail detail screen AND auto-trigger Zolva's draft-reply
  // generator on mount. Bypasses the chat entirely so the user lands in
  // the mail editor with a ready-to-send draft instead of round-tripping
  // through tools just to produce the same thing.
  | { kind: 'mailDraft'; mailId: string };

export type Observation = {
  id: string;
  text: string;
  cta: string;
  mood: StoneMood;
  action?: ObservationAction;
};

export type EventAttendee = {
  name?: string;
  email?: string;
};

export type UpcomingEvent = {
  id: string;
  time: string;
  meta: string;
  title: string;
  sub: string;
  tone: Tone;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees?: EventAttendee[];
  color?: string;
  source: 'google' | 'microsoft' | 'demo' | 'icloud';
};

export type MailProvider = 'google' | 'microsoft' | 'icloud';

// Urgency tier assigned by the inbox sort. Drives the sectioned UI in
// InboxScreen - tier 0 is always visible, the rest are collapsible.
//   0 - haster (classifier confirmed reply needed, or subject keyword)
//   1 - venter på dig (human-looking, undecided by classifier)
//   2 - nyhedsbreve (body looks automated / classifier said no reply)
//   3 - auto-mails (no-reply / mailer-daemon / marketing senders)
export type UrgencyTier = 0 | 1 | 2 | 3;

export type InboxMail = {
  id: string;
  provider: MailProvider;
  from: string;
  subject: string;
  time: string;
  tone: 'sage' | 'clay' | 'mist';
  initials: string;
  aiDraft: string | null;
  tier: UrgencyTier;
};

export type ReplyContext =
  | {
      provider: 'google';
      threadId: string;
      messageIdHeader: string;
      references: string;
      replyTo: string;
      subject: string;
    }
  | {
      provider: 'microsoft';
      messageId: string;
    }
  | {
      provider: 'icloud';
      uid: number;
      subject: string;
      fromEmail: string;   // address to reply to - sender of the original
    };

export type MailDetail = {
  id: string;
  provider: MailProvider;
  from: string;
  subject: string;
  body: string;
  replyContext: ReplyContext;
};

export type DoneMail = {
  id: string;
  from: string;
  note: string;
};

export type CalendarSlot = {
  hour: string;
  event: {
    id: string;
    title: string;
    sub: string;
    tone: 'sage' | 'clay' | 'mist';
    // Minutes past the slot's hour where the event begins (0..59) and total
    // duration. The renderer absolute-positions chips on the hour grid using
    // these so a 5-hour event spans 5 rows instead of being squashed into one.
    startMinute: number;
    durationMinutes: number;
  } | null;
};

// An optional actionable affordance the chat renders below an assistant
// message. `pick_drive_files` opens the Google Drive Picker - surfaced when a
// Drive tool came back empty under the `drive.file` scope (the file the user
// asked about hasn't been granted to Zolva yet). `send_draft` carries the
// draft the agent just created via create_draft, so the chat can offer a
// one-tap "Send svar" (with a confirm guard) + a "Se udkast" preview without
// the user leaving the app to open their mail client.
export type SendDraftAction = {
  kind: 'send_draft';
  label: string;
  provider: 'google' | 'microsoft' | 'icloud';
  // Provider draft id, so Gmail/Outlook can send the exact draft (no leftover
  // in the Drafts folder). null for iCloud - its append-draft API returns no
  // id, so send re-posts the body via SMTP (the appended draft stays).
  draftId: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  // Raw body as the agent wrote it (no signature - that's appended at send).
  body: string;
  // Original mail's unified id when this is a reply (drives recordSentMail +
  // the local "replied" dismiss). undefined for fresh mails.
  replyToUnifiedId?: string;
  // iCloud reply UID (numeric) for threaded SMTP sends.
  replyToUid?: number;
  // Gmail threading headers, kept so a body re-send fallback still threads.
  threadId?: string;
  inReplyTo?: string;
  references?: string;
};

export type ChatMessageAction =
  | { kind: 'pick_drive_files'; label: string }
  | SendDraftAction;

export type ChatMessage = {
  id: string;
  from: 'zolva' | 'user';
  text: string;
  // ISO 8601 with timezone offset. Stamped on send so historical messages
  // carry their original wall-clock when re-sent to Claude - without it the
  // model interprets phrases like "i dag kl 17:30" relative to the current
  // turn, not when the message was originally written.
  createdAt?: string;
  // Transient UI affordance (e.g. a "Vælg Drive-filer" chip). Not persisted
  // to chat_messages - it's recomputed per turn, never part of AI memory.
  action?: ChatMessageAction;
};

export type IntegrationKey =
  | 'google-calendar'
  | 'gmail'
  | 'google-drive'
  | 'outlook-calendar'
  | 'outlook-mail'
  | 'onedrive'
  | 'icloud';

export type IntegrationStatus = 'connected' | 'pending' | 'expired' | 'stale' | 'disconnected';
// 'pending' = transient user-initiated (OAuth in flight) - currently unused, reserved.
// 'expired' = persistent, credential rejected by provider, user must re-enter
//   (today only set by iCloud when Apple rejects the app-specific password).
// 'stale'   = transient, OAuth identity still linked at Supabase but the
//   in-memory access-token cache is null - silent refresh failed or hasn't
//   completed yet. Auto-recovers on the next successful refresh; the user
//   can also Frakobl + reconnect to force a fresh grant.

export type Connection = {
  id: IntegrationKey;
  title: string;
  sub: string;
  status: IntegrationStatus;
  logo: `${IntegrationKey}.png`;
};

export type WorkPreferenceId =
  | 'autonomy'
  | 'tone'
  | 'morning-brief'
  | 'midday-brief'
  | 'quiet-hours'
  | 'evening-brief';

export type WorkPreference = {
  id: WorkPreferenceId;
  title: string;
  meta: string;
  value: string | null;
  options: string[];
};

export type PrivacyToggle = {
  id: string;
  label: string;
  enabled: boolean;
};

export type ReminderStatus = 'pending' | 'done';

export type Reminder = {
  id: string;
  text: string;
  dueAt: Date | null;
  status: ReminderStatus;
  createdAt: Date;
  doneAt: Date | null;
  firedAt: Date | null;
  scheduledForTz: string | null;
};

export type NoteCategory = 'task' | 'idea' | 'note' | 'info';

export type Note = {
  id: string;
  text: string;
  category: NoteCategory;
  createdAt: Date;
};

export type Result<T> = {
  data: T;
  loading: boolean;
  error: Error | null;
};

export type NotificationPayload =
  | { type: 'reminder'; reminderId: string }
  | { type: 'digest'; date: string }
  | { type: 'calendarPreAlert'; eventId: string }
  | { type: 'reminderAdded'; reminderId: string }
  | { type: 'newMail'; provider: MailProvider; messageId: string; threadId?: string }
  | { type: 'brief'; briefId: string }
  // Heads-up that an action-y fact ("Oscar to vet Friday") is about to drop
  // out of morning briefs. Tap routes the user to the Memory tab so they can
  // confirm/extend or let it go.
  | { type: 'factDecay'; factId: string }
  // Sent when a tenant admin grants Zolva consent. Tap routes the user back
  // to Settings so they can finally connect their work account.
  | { type: 'microsoftConsentGranted'; tenantDomain: string }
  // Sent when a backgrounded chat turn finishes. Tap reopens chat at the
  // resolved job; the answer text lives on the chat_jobs row keyed by jobId.
  | { type: 'chatReply'; jobId: string }
  // Sent when the autonomous agent proposes an action for user review.
  // Tap routes to Today where the proposal card is displayed.
  | { type: 'agent_proposal'; action_id: string };

export type FeedEntryType = NotificationPayload['type'];

export type FeedEntry = {
  id: string;
  type: FeedEntryType;
  title: string;
  body?: string;
  firesAt: Date;
  createdAt: Date;
  readAt: Date | null;
  payload: NotificationPayload;
};

export type FactCategory =
  | 'relationship'
  | 'role'
  | 'preference'
  | 'project'
  | 'commitment'
  | 'other';

export type FactStatus = 'pending' | 'confirmed' | 'rejected';

export type Fact = {
  id: string;
  userId: string;
  text: string;
  normalizedText: string;
  category: FactCategory;
  status: FactStatus;
  source: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
  rejectionTtl: Date | null;
  // Action-y facts (commitments, "Oscar has to be at the vet Friday") get an
  // expiry so they stop appearing in briefs after the referent moment passes.
  // NULL means the fact is treated as permanent (relations/role/preference).
  expiresAt: Date | null;
};

export type MailEventType =
  | 'read'
  | 'deferred'
  | 'dismissed'
  | 'drafted_reply'
  | 'replied';

export type MailEvent = {
  id: string;
  userId: string;
  eventType: MailEventType;
  providerThreadId: string;
  providerFrom: string | null;
  providerTo: string | null;
  providerSubject: string | null;
  occurredAt: Date;
};

export type ChatMessageRow = {
  id: string;
  userId: string;
  clientId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: Date;
};
