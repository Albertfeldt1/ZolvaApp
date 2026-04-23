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

export const DEMO_EMAIL = 'demo@zolva.dk';
export const DEMO_USER_ID = 'demo-user-00000000-0000-4000-8000-000000000000';

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
// user.user_metadata anywhere that matters — other fields are cast-through
// so we don't have to fabricate real JWTs.
export function buildDemoSession(): Session {
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
      user_metadata: { name: 'Demo Bruger', full_name: 'Demo Bruger' },
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

function today(h: number, m: number): Date {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
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

type DemoEventSeed = {
  id: string;
  hour: number;
  min: number;
  durationMin: number;
  title: string;
  sub: string;
  tone: 'sage' | 'clay' | 'mist';
  location?: string;
  description?: string;
  attendees?: Array<{ name: string; email?: string }>;
  color: string;
};

// Colors mirror Google Calendar's palette so demo events look native alongside
// real-data users.
const DEMO_EVENTS: DemoEventSeed[] = [
  {
    id: 'd-ev-1',
    hour: 9,
    min: 30,
    durationMin: 30,
    title: 'Stand-up',
    sub: 'Zoom · 30 min',
    tone: 'sage',
    location: 'Zoom',
    description: 'Daglig synk med teamet. Hurtige opdateringer, ingen beslutninger.',
    attendees: [
      { name: 'Sofia Wang', email: 'sofia@zolva.dk' },
      { name: 'Jonas Krogh', email: 'jonas@zolva.dk' },
    ],
    color: '#0B8043', // Basil
  },
  {
    id: 'd-ev-2',
    hour: 11,
    min: 0,
    durationMin: 60,
    title: 'Kundemøde · Lunar',
    sub: 'Tingbjergvej 5 · 60 min',
    tone: 'clay',
    location: 'Tingbjergvej 5, 2. sal',
    description:
      'Gennemgang af Q3-oplæg. Mette vil gerne se det færdige tilbud, og vi tager en runde om leverancetider. Husk at printe kontraktudkastet.',
    attendees: [
      { name: 'Mette Halling', email: 'mette@lunar.dk' },
      { name: 'Anders Brix', email: 'anders@lunar.dk' },
    ],
    color: '#F4511E', // Tangerine
  },
  {
    id: 'd-ev-3',
    hour: 13,
    min: 0,
    durationMin: 45,
    title: 'Frokost med Jonas',
    sub: 'Café Norden · 45 min',
    tone: 'mist',
    location: 'Café Norden, Østergade 61',
    attendees: [{ name: 'Jonas Krogh' }],
    color: '#F6BF26', // Banana
  },
  {
    id: 'd-ev-4',
    hour: 15,
    min: 30,
    durationMin: 30,
    title: '1:1 med Sofia',
    sub: 'Kontoret · 30 min',
    tone: 'sage',
    location: 'Kontoret, mødelokale 2',
    description: 'Fortsættelse fra sidste uges samtale om onboarding.',
    attendees: [{ name: 'Sofia Wang' }],
    color: '#3F51B5', // Blueberry
  },
];

export function demoUpcoming(): UpcomingEvent[] {
  const now = new Date();
  return DEMO_EVENTS.map((e) => {
    const start = today(e.hour, e.min);
    const end = new Date(start.getTime() + e.durationMin * 60000);
    const diffMin = Math.round((start.getTime() - now.getTime()) / 60000);
    const meta =
      diffMin <= 0 && end.getTime() > now.getTime()
        ? 'i gang'
        : diffMin > 0 && diffMin < 60
          ? `om ${diffMin} min`
          : diffMin > 0 && diffMin < 720
            ? `om ${Math.round(diffMin / 60)} t`
            : `${e.durationMin} min`;
    return {
      id: e.id,
      time: clock(e.hour, e.min),
      meta,
      title: e.title,
      sub: e.sub,
      tone: e.tone,
      start,
      end,
      allDay: false,
      location: e.location,
      description: e.description,
      attendees: e.attendees,
      color: e.color,
      source: 'demo' as const,
    };
  }).filter((e) => e.end.getTime() >= now.getTime());
}

type DemoMail = {
  id: string;
  from: string;
  subject: string;
  minutesAgo: number;
  unread: boolean;
  aiDraft: string | null;
};

const DEMO_MAILS: DemoMail[] = [
  { id: 'd-m-1', from: 'Mette Halling', subject: 'Tilbud til Q3 kampagne', minutesAgo: 8, unread: true, aiDraft: 'Hej Mette,\n\nTak for din interesse. Jeg sender et oplæg inden frokost.\n\nVenlig hilsen' },
  { id: 'd-m-2', from: 'Anders Brix', subject: 'Re: kontrakt', minutesAgo: 34, unread: true, aiDraft: null },
  { id: 'd-m-3', from: 'Lunar Support', subject: 'Din saldo er opdateret', minutesAgo: 120, unread: true, aiDraft: null },
  { id: 'd-m-4', from: 'Sofia Wang', subject: 'Spørgsmål om retroen', minutesAgo: 180, unread: true, aiDraft: null },
  { id: 'd-m-5', from: 'Unity Team', subject: 'Nye features i april', minutesAgo: 420, unread: true, aiDraft: null },
  { id: 'd-m-6', from: 'Jonas Krogh', subject: 'Frokost i dag?', minutesAgo: 1500, unread: false, aiDraft: null },
  { id: 'd-m-7', from: 'Bogholderi', subject: 'Bilag modtaget', minutesAgo: 2880, unread: false, aiDraft: null },
  { id: 'd-m-8', from: 'DSB', subject: 'Kvittering - rejse', minutesAgo: 4320, unread: false, aiDraft: null },
  { id: 'd-m-9', from: 'LinkedIn', subject: 'Nye stillinger', minutesAgo: 5760, unread: false, aiDraft: null },
];

export function demoInboxWaiting(): InboxMail[] {
  const now = new Date();
  const tones: InboxMail['tone'][] = ['sage', 'clay', 'mist'];
  return DEMO_MAILS
    .filter((m) => m.unread)
    .map((m, i) => ({
      id: m.id,
      provider: 'google' as const,
      from: m.from,
      subject: m.subject,
      time: timeAgoLabel(minutesAgo(m.minutesAgo), now),
      tone: tones[i % tones.length],
      initials: initialsOf(m.from),
      aiDraft: m.aiDraft,
    }));
}

export function demoInboxCleared(): { items: DoneMail[]; count: number } {
  const cleared = DEMO_MAILS.filter((m) => !m.unread);
  return {
    items: cleared.slice(0, 6).map((m) => ({ id: m.id, from: m.from, note: m.subject })),
    count: cleared.length,
  };
}

export function demoInboxArchived(): InboxMail[] {
  const now = new Date();
  const tones: InboxMail['tone'][] = ['sage', 'clay', 'mist'];
  return DEMO_MAILS
    .filter((m) => !m.unread)
    .map((m, i) => ({
      id: m.id,
      provider: 'google' as const,
      from: m.from,
      subject: m.subject,
      time: timeAgoLabel(minutesAgo(m.minutesAgo), now),
      tone: tones[i % tones.length],
      initials: initialsOf(m.from),
      aiDraft: m.aiDraft,
    }));
}

export function demoDaySchedule(): CalendarSlot[] {
  const SLOT_START = 9;
  const SLOT_COUNT = 8;
  const slots: CalendarSlot[] = Array.from({ length: SLOT_COUNT }, (_, i) => ({
    hour: String(SLOT_START + i).padStart(2, '0'),
    event: null,
  }));
  DEMO_EVENTS.forEach((e) => {
    const idx = e.hour - SLOT_START;
    if (idx < 0 || idx >= SLOT_COUNT) return;
    slots[idx] = {
      hour: slots[idx].hour,
      event: { id: `d-sch-${e.id}`, title: e.title, sub: e.sub, tone: e.tone },
    };
  });
  return slots;
}

export const DEMO_CONNECTIONS: Connection[] = [
  { id: 'google-calendar', title: 'Google Kalender', sub: 'Læser & opretter begivenheder', status: 'connected', logo: 'google-calendar.png' },
  { id: 'gmail', title: 'Gmail', sub: 'Søger, læser og sender', status: 'connected', logo: 'gmail.png' },
  { id: 'google-drive', title: 'Google Drive', sub: 'Søger og læser tekstfiler', status: 'connected', logo: 'google-drive.png' },
  { id: 'outlook-calendar', title: 'Outlook Kalender', sub: 'Microsoft 365', status: 'connected', logo: 'outlook-calendar.png' },
  { id: 'outlook-mail', title: 'Outlook Mail', sub: 'Microsoft 365', status: 'connected', logo: 'outlook-mail.png' },
];

export const DEMO_SUBSCRIPTION: Subscription = {
  priceKr: 99,
  plan: 'Zolva Pro',
  renewalDate: '15. maj',
};

export function demoReminders(): Reminder[] {
  const now = Date.now();
  return [
    { id: 'd-r-1', text: 'Ring til tandlægen', dueAt: today(14, 0), status: 'pending', createdAt: new Date(now - 3 * 86400000), doneAt: null },
    { id: 'd-r-2', text: 'Godkend faktura #4021', dueAt: today(16, 30), status: 'pending', createdAt: new Date(now - 86400000), doneAt: null },
    { id: 'd-r-3', text: 'Svar Sofia om retro', dueAt: null, status: 'pending', createdAt: new Date(now - 7200000), doneAt: null },
  ];
}

export function demoNotes(): Note[] {
  const now = Date.now();
  return [
    { id: 'd-n-1', text: 'Idéer til Q3 roadmap', category: 'idea', createdAt: new Date(now - 2 * 86400000) },
    { id: 'd-n-2', text: 'Husk at sende tak-mail til Lunar', category: 'task', createdAt: new Date(now - 86400000) },
  ];
}

export const DEMO_OBSERVATIONS: Observation[] = [
  { id: 'd-o-1', text: 'Mette fra Lunar venter stadig på svar fra i går.', cta: 'Lav udkast', mood: 'thinking' },
  { id: 'd-o-2', text: 'Du har et vindue 10.00-10.45 hvis du vil forberede kundemødet.', cta: 'Bloker tid', mood: 'calm' },
];

export const DEMO_CHAT_SCRIPT: string[] = [
  'Godmorgen. Du har 4 ting i kalenderen i dag. Kundemødet 11.00 med Lunar er det vigtigste.',
  'Mette venter på tilbuddet. Jeg har lagt et udkast klar - vil du se det?',
  'Klaret. Sendt 10.02.',
  'Sofia spurgte til retroen - jeg har foreslået torsdag kl. 14.00.',
  'Ja, jeg flytter stand-up til 09.45 i morgen.',
  'Tak. God dag.',
];

export const DEMO_CHAT_FALLBACK = 'Lad mig undersøge det og vende tilbage.';

export { DEMO_PROFILE_PREAMBLE } from './profile-demo';

const DEMO_MAIL_BODIES: Record<string, string> = {
  'd-m-1':
    'Hej,\n\nTak for dit oplæg i sidste uge. Vi er klar til at tage næste skridt på Q3-kampagnen, og ledelsen vil gerne se et konkret tilbud inden onsdag.\n\nKan du sende et udkast med pris og leveringsplan?\n\nMvh\nMette Halling',
  'd-m-2':
    'Hej,\n\nKontrakten ser fin ud fra vores side. En enkelt rettelse i §4 — kan vi tage det over en kort snak i morgen?\n\nVenlig hilsen\nAnders',
  'd-m-3':
    'Kære kunde,\n\nDin saldo er opdateret efter din seneste transaktion. Du kan se detaljerne i Lunar-appen.\n\nLunar Support',
  'd-m-4':
    'Hej,\n\nJeg tænkte vi skulle tage en retro på sidste sprint. Har du tid på torsdag eftermiddag? Jeg kan reservere mødelokalet.\n\nSofia',
  'd-m-5':
    'Hej team,\n\nHer er de største ændringer i april-udgivelsen: ny søgefunktion, hurtigere indlæsning, og opdateret notifikationsflow.\n\nGod læselyst!\nUnity Team',
  'd-m-6':
    'Hej,\n\nFrokost i dag kl. 13? Jeg tænkte Café Norden. Sig til hvis det passer.\n\nJonas',
  'd-m-7':
    'Hej,\n\nBilaget er modtaget og bogført. Vi vender tilbage hvis der mangler noget.\n\nMvh\nBogholderi',
  'd-m-8':
    'Kære kunde,\n\nHer er din kvittering for togrejsen København-Aarhus den 17. april.\n\nDSB',
  'd-m-9':
    'Hej,\n\nHer er 5 nye stillinger der matcher din profil. Log ind for at se mere.\n\nLinkedIn',
};

export function demoMailDetail(id: string): MailDetail | null {
  const mail = DEMO_MAILS.find((m) => m.id === id);
  if (!mail) return null;
  const body = DEMO_MAIL_BODIES[id] ?? '(tom besked)';
  return {
    id,
    provider: 'google',
    from: mail.from,
    subject: mail.subject,
    body,
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
