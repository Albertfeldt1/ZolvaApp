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
  | { kind: 'openMail'; mailId: string };

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

export type InboxMail = {
  id: string;
  provider: MailProvider;
  from: string;
  subject: string;
  time: string;
  tone: 'sage' | 'clay' | 'mist';
  initials: string;
  aiDraft: string | null;
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
  // iCloud reads only in v1 — replies require SMTP send + thread-aware
  // headers. The detail screen uses this context to identify the mail;
  // useSendReply rejects iCloud with a "not supported" message.
  | {
      provider: 'icloud';
      uid: number;
      subject: string;
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
  } | null;
};

export type ChatMessage = {
  id: string;
  from: 'zolva' | 'user';
  text: string;
};

export type IntegrationKey =
  | 'google-calendar'
  | 'gmail'
  | 'google-drive'
  | 'outlook-calendar'
  | 'outlook-mail'
  | 'icloud';

export type IntegrationStatus = 'connected' | 'pending' | 'expired' | 'disconnected';
// 'pending' = transient user-initiated (OAuth in flight) — currently unused, reserved.
// 'expired' = persistent, credential rejected by provider, user must re-enter.

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
  | { type: 'microsoftConsentGranted'; tenantDomain: string };

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
