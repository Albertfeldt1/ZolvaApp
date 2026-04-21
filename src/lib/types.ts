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
};

export type MailProvider = 'google' | 'microsoft';

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
  | 'outlook-mail';

export type IntegrationStatus = 'connected' | 'pending' | 'disconnected';

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
  | { type: 'newMail'; provider: MailProvider; messageId: string; threadId?: string };

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
