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

export type Observation = {
  id: string;
  text: string;
  cta: string;
  mood: StoneMood;
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

export type WorkPreferenceId = 'autonomy' | 'tone' | 'morning-brief' | 'quiet-hours';

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
  dueAt: Date;
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
