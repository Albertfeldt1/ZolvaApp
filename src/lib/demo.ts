import type { Session } from '@supabase/supabase-js';
import type {
  CalendarSlot,
  Connection,
  DoneMail,
  InboxMail,
  MailDetail,
  Note,
  Observation,
  Reminder,
  Subscription,
  UpcomingEvent,
} from './types';
import {
  DEMO_MAIL_SEEDS,
  DEMO_USER_ID,
  demoEventsForDay,
  demoNoteList,
  demoObservationList,
  demoReminderList,
  resetDemoData,
} from './demo-data';

export const DEMO_EMAIL = 'demo@zolva.dk';
export { DEMO_USER_ID, isDemoUserId } from './demo-data';

// Any of these email values paired with any of these passwords signs the
// user into demo mode. Kept loose so a presenter can type whatever they
// remember ("demo", "demo123") without failing login.
const DEMO_EMAIL_ALIASES = new Set(['demo', 'demo123', DEMO_EMAIL]);
const DEMO_PASSWORDS = new Set(['demo', 'demo123']);

export function isDemoCredentials(email: string, password: string): boolean {
  return DEMO_EMAIL_ALIASES.has(email.trim().toLowerCase()) && DEMO_PASSWORDS.has(password);
}

export function isDemoUser(user: { email?: string | null } | null | undefined): boolean {
  return !!user?.email && user.email.toLowerCase() === DEMO_EMAIL;
}

// Minimal Session shape. The app only reads user.id / user.email /
// user.user_metadata anywhere that matters - other fields are cast-through
// so we don't have to fabricate real JWTs.
export function buildDemoSession(): Session {
  // Fresh demo login = fresh demo universe. This is the "nulstil med ét
  // klik": log ud og ind igen, og alle demo-mutationer er væk.
  resetDemoData();
  const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  return {
    access_token: 'demo-access-token',
    refresh_token: 'demo-refresh-token',
    token_type: 'bearer',
    expires_in: 60 * 60 * 24 * 365,
    expires_at: farFuture,
    user: {
      id: DEMO_USER_ID,
      email: DEMO_EMAIL,
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: { provider: 'demo' },
      user_metadata: { name: 'Frederik Lund', full_name: 'Frederik Lund' },
      created_at: new Date().toISOString(),
      identities: [],
    },
  } as unknown as Session;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function clock(h: number, m: number): string {
  return `${pad(h)}.${pad(m)}`;
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60000);
}

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function timeAgoLabel(date: Date, now: Date): string {
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `${pad(date.getHours())}.${pad(date.getMinutes())}`;
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diffDays < 7) return `${diffDays}d`;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}

/** Kommende aftaler: resten af i dag + de næste dage, så listen aldrig er tom. */
export function demoUpcoming(): UpcomingEvent[] {
  const now = new Date();
  const out: UpcomingEvent[] = [];
  for (let offset = 0; offset <= 7 && out.length < 8; offset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    for (const e of demoEventsForDay(day)) {
      const start = new Date(day);
      start.setHours(e.hour, e.min, 0, 0);
      const end = e.allDay
        ? new Date(new Date(start).setHours(23, 59, 0, 0))
        : new Date(start.getTime() + e.durationMin * 60000);
      if (end.getTime() < now.getTime()) continue;
      const diffMin = Math.round((start.getTime() - now.getTime()) / 60000);
      const meta = e.allDay
        ? 'hele dagen'
        : diffMin <= 0 && end.getTime() > now.getTime()
          ? 'i gang'
          : diffMin > 0 && diffMin < 60
            ? `om ${diffMin} min`
            : diffMin > 0 && diffMin < 720
              ? `om ${Math.round(diffMin / 60)} t`
              : offset === 0
                ? `${e.durationMin} min`
                : offset === 1
                  ? 'i morgen'
                  : `om ${offset} dage`;
      out.push({
        id: e.id,
        time: e.allDay ? '—' : clock(e.hour, e.min),
        meta,
        title: e.title,
        sub: e.sub,
        tone: e.tone,
        start,
        end,
        allDay: !!e.allDay,
        location: e.location,
        description: e.description,
        attendees: e.attendees,
        color: e.color,
        source: 'demo' as const,
      });
      if (out.length >= 8) break;
    }
  }
  return out;
}

/** Rå dags-events til Plan-fanens tidslinje (per valgt dato). */
export function demoDayEventList(targetDate: Date): Array<{
  id: string;
  title: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
}> {
  return demoEventsForDay(targetDate).map((e) => {
    const start = new Date(targetDate);
    start.setHours(e.hour, e.min, 0, 0);
    const end = e.allDay
      ? new Date(new Date(start).setHours(23, 59, 0, 0))
      : new Date(start.getTime() + e.durationMin * 60000);
    return { id: e.id, title: e.title, location: e.location ?? e.sub, start, end, allDay: !!e.allDay };
  });
}

const DEMO_UNREAD = DEMO_MAIL_SEEDS.filter((m) => m.unread);
const DEMO_READ = DEMO_MAIL_SEEDS.filter((m) => !m.unread);

export function demoInboxWaiting(): InboxMail[] {
  const now = new Date();
  const tones: InboxMail['tone'][] = ['sage', 'clay', 'mist'];
  return DEMO_UNREAD.map((m, i) => ({
    id: m.id,
    provider: 'google' as const,
    from: m.from,
    subject: m.subject,
    preview: m.preview,
    time: timeAgoLabel(minutesAgo(m.minutesAgo), now),
    tone: tones[i % tones.length],
    initials: initialsOf(m.from),
    aiDraft: m.aiDraft,
    tier: m.tier,
  }));
}

export function demoInboxCleared(): { items: DoneMail[]; count: number } {
  return {
    items: DEMO_READ.slice(0, 6).map((m) => ({ id: m.id, from: m.from, note: m.subject })),
    count: DEMO_READ.length,
  };
}

export function demoInboxArchived(): InboxMail[] {
  const now = new Date();
  const tones: InboxMail['tone'][] = ['sage', 'clay', 'mist'];
  return DEMO_READ.map((m, i) => ({
    id: m.id,
    provider: 'google' as const,
    from: m.from,
    subject: m.subject,
    preview: m.preview,
    time: timeAgoLabel(minutesAgo(m.minutesAgo), now),
    tone: tones[i % tones.length],
    initials: initialsOf(m.from),
    aiDraft: m.aiDraft,
    tier: m.tier,
  }));
}

/** Time-slot-visning af en dag (bruges af klassisk kalender + Papir-plan). */
export function demoDaySchedule(targetDate?: Date): CalendarSlot[] {
  const day = targetDate ?? new Date();
  const events = demoEventsForDay(day);
  const timed = events.filter((e) => !e.allDay);
  const allDay = events.filter((e) => e.allDay);

  const SLOT_START = 8;
  const SLOT_COUNT = 12;
  const slots: CalendarSlot[] = Array.from({ length: SLOT_COUNT }, (_, i) => ({
    hour: String(SLOT_START + i).padStart(2, '0'),
    event: null,
  }));
  timed.forEach((e) => {
    const idx = e.hour - SLOT_START;
    if (idx < 0 || idx >= SLOT_COUNT) return;
    if (slots[idx].event) return; // first event wins the slot in this compact view
    slots[idx] = {
      hour: slots[idx].hour,
      event: {
        id: `d-sch-${e.id}`,
        title: e.title,
        sub: e.sub,
        tone: e.tone,
        startMinute: e.min,
        durationMinutes: e.durationMin,
      },
    };
  });
  const allDaySlots: CalendarSlot[] = allDay.map((e) => ({
    hour: '-',
    event: {
      id: `d-sch-${e.id}`,
      title: e.title,
      sub: e.location ?? 'Hele dagen',
      tone: e.tone,
      startMinute: 0,
      durationMinutes: 60,
    },
  }));
  return [...allDaySlots, ...slots];
}

export const DEMO_CONNECTIONS: Connection[] = [
  { id: 'google-calendar', title: 'Google Kalender', sub: 'Læser & opretter begivenheder', status: 'connected', logo: 'google-calendar.png' },
  { id: 'gmail', title: 'Gmail', sub: 'Søger, læser og sender', status: 'connected', logo: 'gmail.png' },
  { id: 'google-drive', title: 'Google Drive', sub: 'Søger og læser tekstfiler', status: 'connected', logo: 'google-drive.png' },
  { id: 'outlook-calendar', title: 'Outlook Kalender', sub: 'Microsoft 365', status: 'connected', logo: 'outlook-calendar.png' },
  { id: 'outlook-mail', title: 'Outlook Mail', sub: 'Microsoft 365', status: 'connected', logo: 'outlook-mail.png' },
  { id: 'onedrive', title: 'OneDrive', sub: 'Søger og læser tekstfiler', status: 'connected', logo: 'onedrive.png' },
];

export const DEMO_SUBSCRIPTION: Subscription = {
  priceKr: 99,
  plan: 'Zolva Pro',
  renewalDate: '15. august',
};

export function demoReminders(): Reminder[] {
  return demoReminderList();
}

export function demoNotes(): Note[] {
  return demoNoteList();
}

export const DEMO_OBSERVATIONS: Observation[] = demoObservationList();

// Legacy fixed script — kept as fallback; useChat routes through
// demoChatReply() (keyword-matched) first.
export const DEMO_CHAT_SCRIPT: string[] = [
  'Godmorgen. Du har 5 ting i kalenderen i dag — kundemødet 11.00 med Lunar er det vigtigste.',
  'Mette venter på tilbuddet. Jeg har lagt et udkast klar — vil du se det?',
  'Klaret. Sendt 10.02.',
  'Sofia spurgte til retroen — jeg har foreslået torsdag kl. 14.00.',
  'Ja, jeg flytter stand-up til 09.45 i morgen.',
  'Tak. God dag.',
];

export const DEMO_CHAT_FALLBACK = 'Lad mig undersøge det og vende tilbage.';

export { DEMO_PROFILE_PREAMBLE } from './profile-demo';
export { demoChatReply } from './demo-data';

export function demoMailDetail(id: string): MailDetail | null {
  const mail = DEMO_MAIL_SEEDS.find((m) => m.id === id);
  if (!mail) return null;
  return {
    id,
    provider: 'google',
    from: mail.from,
    subject: mail.subject,
    body: mail.body,
    replyContext: {
      provider: 'google',
      threadId: `d-thread-${id}`,
      messageIdHeader: `<${id}@demo.zolva.dk>`,
      references: `<${id}@demo.zolva.dk>`,
      replyTo: `${mail.from.toLowerCase().replace(/\s+/g, '.')}@example.dk`,
      subject: `Re: ${mail.subject}`,
    },
  };
}
