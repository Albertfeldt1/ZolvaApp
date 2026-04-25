import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeUserId, useAuth } from './auth';
import {
  DEMO_CHAT_FALLBACK,
  DEMO_CHAT_SCRIPT,
  DEMO_CONNECTIONS,
  DEMO_OBSERVATIONS,
  DEMO_SUBSCRIPTION,
  demoDaySchedule,
  demoInboxArchived,
  demoInboxCleared,
  demoInboxWaiting,
  demoMailDetail,
  demoNotes,
  demoReminders,
  demoUpcoming,
  isDemoUser,
} from './demo';
import {
  complete,
  completeJson,
  completeRaw,
  hasClaudeKey,
  type ClaudeMessage,
  type ClaudeToolSchema,
} from './claude';
import {
  addNote as storeAddNote,
  addReminder as storeAddReminder,
  listNotes,
  listReminders,
  markReminderDone as storeMarkReminderDone,
  removeNote as storeRemoveNote,
  removeReminder as storeRemoveReminder,
  subscribeNotes,
  subscribeReminders,
} from './memory-store';
import {
  eventEnd,
  eventStart,
  isAllDay as isGoogleAllDay,
  listEvents as listGoogleEvents,
  resolveGoogleEventColor,
} from './google-calendar';
import {
  archiveMessage as gmailArchiveMessage,
  getMessageBody as gmailGetMessageBody,
  initialsOf,
  listInboxMessages as listGmailMessages,
  sendReply as gmailSendReply,
} from './gmail';
import {
  archiveMessage as graphArchiveMessage,
  getMessageBody as graphGetMessageBody,
  listCalendarEvents as listGraphEvents,
  listInboxMessages as listGraphMessages,
  replyToMessage as graphReplyToMessage,
} from './microsoft-graph';
import type {
  CalendarSlot,
  ChatMessage,
  Connection,
  DoneMail,
  EventAttendee,
  Fact,
  FeedEntry,
  InboxMail,
  MailDetail,
  MailProvider,
  Note,
  Observation,
  PrivacyToggle,
  Reminder,
  ReplyContext,
  Result,
  Subscription,
  UpcomingEvent,
  UserProfile,
  WorkPreference,
  WorkPreferenceId,
} from './types';
import { confirmFact, listFacts, rejectFact } from './profile-store';
import { invalidatePreamble } from './profile';
import {
  listFeedEntries,
  markAllFeedRead,
  markFeedEntryRead,
  subscribeFeed,
} from './notification-feed';
import { syncChatMessage } from './chat-sync';
import { runExtractor } from './profile-extractor';
import {
  CHAT_SUGGESTION_COUNT,
  extractChatSuggestions,
  padSuggestions,
  type MailForSuggestion,
} from './chat-suggestions';
import { supabase } from './supabase';

// All hooks return placeholder/empty state. When the backend is wired,
// swap the internals for real data sources (Supabase auth, API fetches,
// realtime subscriptions) without touching the screens.

const empty = <T>(data: T): Result<T> => ({ data, loading: false, error: null });

export function useUser(): Result<UserProfile | null> {
  const { user, initializing } = useAuth();
  if (initializing) return { data: null, loading: true, error: null };
  if (!user) return empty(null);
  const meta = (user.user_metadata ?? {}) as { name?: string; full_name?: string };
  const name = meta.name ?? meta.full_name ?? user.email?.split('@')[0] ?? '';
  return empty({ name, email: user.email ?? '' });
}

export function useSubscription(): Result<Subscription | null> {
  const { user } = useAuth();
  if (isDemoUser(user)) return empty(DEMO_SUBSCRIPTION);
  return empty(null);
}

type ObservationCacheEntry = { expiresAt: number; data: Observation[] };
const OBSERVATION_TTL_MS = 15 * 60 * 1000;
const observationCache = new Map<string, ObservationCacheEntry>();

const OBSERVATION_MAX = 8;

const OBSERVATION_SYSTEM =
  'Du er Zolva, en rolig dansk AI-assistent. Du kigger på brugerens dag og ' +
  'peger blidt på mønstre der er værd at overveje. Svar altid på dansk. ' +
  `Returnér mellem 0 og ${OBSERVATION_MAX} observationer — kun dem der faktisk er relevante, ` +
  'sorteret med de vigtigste først. De første 2–3 vises på forsiden, resten i en oversigt. ' +
  'Hver observation skal være maks én sætning og undgå at gentage selvfølgeligheder.';

const OBSERVATION_SCHEMA =
  '[{"id": string, "text": string, "cta": string, "mood": "calm" | "thinking" | "happy", "action"?: Action}]\n' +
  '- text: selve observationen på dansk (maks én sætning).\n' +
  '- cta: kort handlingsforslag på dansk (maks 4 ord), fx "Åbn mail", "Gennemgå senere" eller "Bloker tid".\n' +
  '- mood: "thinking" for noget der kræver beslutning, "calm" for rolig observation, "happy" for positivt.\n' +
  '- action (valgfri): hvad der skal ske når brugeren trykker på CTA\'en. Typer:\n' +
  '  • {"kind":"openMail","mailId": string} — kun hvis observationen handler om en specifik mail. Brug mail-id\'et vist i [id:…] i mail-listen.\n' +
  '  • {"kind":"prompt","prompt": string} — når brugeren skal notere noget eller følge op senere. "prompt" skal være en færdig 1. person-besked til Zolva på dansk, fx "Noter lige at jeg skal gennemgå Mettes kontrakt senere i dag." Så åbner chatten med beskeden klar til at sende.\n' +
  '  • {"kind":"chat"} — generisk; bruges når intet af ovenstående passer. Udelad action for denne default.';

function summarizeDay(events: NormalizedEvent[], mails: NormalizedMail[]): string {
  const calendar = events.length
    ? events
        .map((e) => {
          const when = e.allDay ? 'hele dagen' : `${clockOf(e.start)}–${clockOf(e.end)}`;
          const where = e.location ? ` @ ${e.location}` : '';
          return `- ${when} ${e.title}${where}`;
        })
        .join('\n')
    : '(ingen begivenheder)';

  const unread = mails.filter((m) => !m.isRead).slice(0, 12);
  const inbox = unread.length
    ? unread.map((m) => `- [id:${m.id}] ${m.from}: ${m.subject}`).join('\n')
    : '(ingen ulæste)';

  return `Dagens kalender:\n${calendar}\n\nUlæste mails:\n${inbox}`;
}

function sanitizeAction(raw: unknown): Observation['action'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as { kind?: unknown; mailId?: unknown; prompt?: unknown };
  if (a.kind === 'openMail' && typeof a.mailId === 'string' && a.mailId.trim()) {
    return { kind: 'openMail', mailId: a.mailId.trim() };
  }
  if (a.kind === 'prompt' && typeof a.prompt === 'string' && a.prompt.trim()) {
    return { kind: 'prompt', prompt: a.prompt.trim() };
  }
  if (a.kind === 'chat') return { kind: 'chat' };
  return undefined;
}

function sanitizeObservations(raw: unknown): Observation[] {
  if (!Array.isArray(raw)) return [];
  const moods: Observation['mood'][] = ['calm', 'thinking', 'happy'];
  return raw.slice(0, OBSERVATION_MAX).flatMap((item, i): Observation[] => {
    if (!item || typeof item !== 'object') return [];
    const o = item as Partial<Observation> & { action?: unknown };
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) return [];
    const cta = typeof o.cta === 'string' ? o.cta.trim() : '';
    const mood = moods.includes(o.mood as Observation['mood'])
      ? (o.mood as Observation['mood'])
      : 'calm';
    const id = typeof o.id === 'string' && o.id ? o.id : `obs-${i + 1}`;
    const action = sanitizeAction(o.action);
    return [action ? { id, text, cta, mood, action } : { id, text, cta, mood }];
  });
}

export function useObservations(): Result<Observation[]> {
  const { user } = useAuth();
  const userId = user?.id;
  const demo = isDemoUser(user);
  const { items: calendarItems, loading: calendarLoading, error: calendarError } =
    useCalendarItems();
  const { items: mailItems, loading: mailLoading, error: mailError } = useMailItems();
  const { data: workRows } = useWorkPreferences();
  const morningBrief = prefValue(workRows, 'morning-brief');
  const quietHours = prefValue(workRows, 'quiet-hours');
  const [state, setState] = useState<Result<Observation[]>>({
    data: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (demo) {
      setState({ data: DEMO_OBSERVATIONS, loading: false, error: null });
      return;
    }
    if (calendarLoading || mailLoading) {
      setState({ data: [], loading: true, error: null });
      return;
    }
    if (calendarError || mailError) {
      setState({ data: [], loading: false, error: calendarError ?? mailError });
      return;
    }
    if (calendarItems.length === 0 && mailItems.length === 0) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    if (!hasClaudeKey()) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    const now = new Date();
    if (isInQuietHours(quietHours, now) || !isMorningBriefReady(morningBrief, now)) {
      setState({ data: [], loading: false, error: null });
      return;
    }

    const summary = summarizeDay(calendarItems, mailItems);
    const cacheKey = summary;
    const cached = observationCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      setState({ data: cached.data, loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    setState((prev) => ({ data: prev.data, loading: true, error: null }));

    completeJson<unknown>({
      signal: controller.signal,
      system: OBSERVATION_SYSTEM,
      schemaHint: OBSERVATION_SCHEMA,
      messages: [{ role: 'user', content: summary }],
      maxTokens: 512,
      temperature: 0.4,
    })
      .then((raw) => {
        if (controller.signal.aborted) return;
        const sanitized = sanitizeObservations(raw);
        observationCache.set(cacheKey, {
          data: sanitized,
          expiresAt: Date.now() + OBSERVATION_TTL_MS,
        });
        setState({ data: sanitized, loading: false, error: null });
        if (userId && sanitized.length > 0) {
          void persistObservations(userId, sanitized);
        }
      })
      .catch((err: Error) => {
        if (controller.signal.aborted || err.name === 'AbortError') return;
        if (__DEV__) console.warn('[hooks] observations fetch failed:', err.message);
        setState({ data: [], loading: false, error: err });
      });

    return () => {
      controller.abort();
    };
  }, [
    demo,
    userId,
    calendarItems,
    mailItems,
    calendarLoading,
    mailLoading,
    calendarError,
    mailError,
    morningBrief,
    quietHours,
  ]);

  return state;
}

async function persistObservations(userId: string, items: Observation[]): Promise<void> {
  const sourceDate = new Date().toISOString().slice(0, 10);
  const rows = items.map((o) => ({
    user_id: userId,
    text: o.text,
    cta: o.cta,
    mood: o.mood,
    source_date: sourceDate,
    action_kind: o.action?.kind ?? null,
    action_payload: actionPayloadFor(o.action),
  }));
  try {
    const { error } = await supabase
      .from('observations')
      .upsert(rows, { onConflict: 'user_id,source_date,text', ignoreDuplicates: true });
    if (error && __DEV__) console.warn('[hooks] observations persist failed:', error.message);
  } catch (err) {
    if (__DEV__) console.warn('[hooks] observations persist failed:', err);
  }
}

function actionPayloadFor(action: Observation['action']): Record<string, string> | null {
  if (!action) return null;
  if (action.kind === 'openMail') return { mailId: action.mailId };
  if (action.kind === 'prompt') return { prompt: action.prompt };
  return null;
}

export type StoredObservation = Observation & {
  generatedAt: Date;
  sourceDate: string;
};

export function useObservationHistory(
  limit = 60,
): { items: StoredObservation[]; loading: boolean; refresh: () => Promise<void> } {
  const { user } = useAuth();
  const userId = user?.id;
  const demo = isDemoUser(user);
  const [items, setItems] = useState<StoredObservation[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || demo) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('observations')
        .select('*')
        .eq('user_id', userId)
        .order('generated_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      setItems((data ?? []).map(rowToStoredObservation));
    } catch (err) {
      if (__DEV__) console.warn('[hooks] observation history failed:', err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [userId, demo, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, loading, refresh };
}

function rowToStoredObservation(r: Record<string, unknown>): StoredObservation {
  const moods: Observation['mood'][] = ['calm', 'thinking', 'happy'];
  const mood = moods.includes(r.mood as Observation['mood'])
    ? (r.mood as Observation['mood'])
    : 'calm';
  return {
    id: r.id as string,
    text: r.text as string,
    cta: (r.cta as string) ?? '',
    mood,
    action: actionFromRow(r),
    generatedAt: new Date(r.generated_at as string),
    sourceDate: r.source_date as string,
  };
}

function actionFromRow(r: Record<string, unknown>): Observation['action'] {
  const kind = r.action_kind;
  const payload = (r.action_payload as Record<string, unknown> | null) ?? null;
  if (kind === 'openMail' && typeof payload?.mailId === 'string') {
    return { kind: 'openMail', mailId: payload.mailId };
  }
  if (kind === 'prompt' && typeof payload?.prompt === 'string') {
    return { kind: 'prompt', prompt: payload.prompt };
  }
  if (kind === 'chat') return { kind: 'chat' };
  return undefined;
}

const TONES: UpcomingEvent['tone'][] = ['sage', 'clay', 'mist'];

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function clockOf(d: Date): string {
  return `${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

function durationLabel(start: Date, end: Date): string {
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} t` : `${h} t ${m} m`;
}

function relativeMeta(start: Date, end: Date, now: Date): string {
  const diffMin = Math.round((start.getTime() - now.getTime()) / 60000);
  if (diffMin > 0 && diffMin < 60) return `om ${diffMin} min`;
  if (diffMin > 0 && diffMin < 720) return `om ${Math.round(diffMin / 60)} t`;
  if (diffMin <= 0 && end.getTime() > now.getTime()) return 'i gang';
  return durationLabel(start, end);
}

function dayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

type NormalizedEvent = {
  id: string;
  title: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  description?: string;
  attendees?: EventAttendee[];
  color?: string;
  source: 'google' | 'microsoft';
};

type NormalizedMail = {
  id: string;
  provider: MailProvider;
  from: string;
  subject: string;
  receivedAt: Date;
  isRead: boolean;
  preview: string;
};

const dismissedMailIds = new Set<string>();
const dismissListeners = new Set<() => void>();

// Clear the dismissed set whenever the active user changes. The first
// notification from subscribeUserId is the initial uid — skip it so we
// don't fire a no-op refresh before any data has been dismissed.
let dismissInitialSeen = false;
subscribeUserId(() => {
  if (!dismissInitialSeen) {
    dismissInitialSeen = true;
    return;
  }
  if (dismissedMailIds.size === 0) return;
  dismissedMailIds.clear();
  dismissListeners.forEach((l) => l());
});

function markMailDismissed(id: string): void {
  if (dismissedMailIds.has(id)) return;
  dismissedMailIds.add(id);
  dismissListeners.forEach((l) => l());
}

function useDismissedMailIds(): Set<string> {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    dismissListeners.add(listener);
    return () => {
      dismissListeners.delete(listener);
    };
  }, []);
  return dismissedMailIds;
}

const CALENDAR_FETCH_TIMEOUT_MS = 20_000;

// Rotate events through a distinct subset of the Google palette so the ribbon
// reads as varied instead of every untagged event defaulting to Blueberry.
// Deterministic (by sorted-start index) so colors don't shuffle on refresh.
const RIBBON_PALETTE = [
  '#3F51B5', // Blueberry
  '#0B8043', // Basil
  '#F4511E', // Tangerine
  '#8E24AA', // Grape
  '#039BE5', // Peacock
  '#D50000', // Tomato
  '#7986CB', // Lavender
  '#33B679', // Sage
  '#F6BF26', // Banana
  '#E67C73', // Flamingo
];

function useCalendarItems(rangeStartMs?: number, rangeEndMs?: number): {
  items: NormalizedEvent[];
  loading: boolean;
  error: Error | null;
} {
  const { googleAccessToken, microsoftAccessToken, user } = useAuth();
  const [state, setState] = useState<{
    items: NormalizedEvent[];
    loading: boolean;
    error: Error | null;
  }>({ items: [], loading: false, error: null });

  useEffect(() => {
    if (!user || (!googleAccessToken && !microsoftAccessToken)) {
      setState({ items: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ items: [], loading: true, error: null });
    const { start, end } =
      rangeStartMs != null && rangeEndMs != null
        ? { start: new Date(rangeStartMs), end: new Date(rangeEndMs) }
        : dayBounds(new Date());

    const tasks: Promise<NormalizedEvent[]>[] = [];
    if (googleAccessToken) {
      tasks.push(
        listGoogleEvents(start, end).then((evts) =>
          evts
            .map((e): NormalizedEvent | null => {
              const s = eventStart(e);
              const ev = eventEnd(e);
              if (!s || !ev) return null;
              const attendees = (e.attendees ?? [])
                .filter((a) => a.self !== true)
                .map((a) => ({ name: a.displayName, email: a.email }));
              return {
                id: e.id,
                title: e.summary ?? 'Uden titel',
                location: e.location,
                start: s,
                end: ev,
                allDay: isGoogleAllDay(e),
                description: e.description,
                attendees: attendees.length ? attendees : undefined,
                color: resolveGoogleEventColor(e),
                source: 'google',
              };
            })
            .filter((e): e is NormalizedEvent => e !== null),
        ),
      );
    }
    if (microsoftAccessToken) {
      tasks.push(
        listGraphEvents(start, end).then((evts) =>
          evts.map((e): NormalizedEvent => ({
            id: e.id,
            title: e.subject,
            location: e.location,
            start: e.start,
            end: e.end,
            allDay: e.isAllDay,
            description: e.description,
            attendees: e.attendeeList.length ? e.attendeeList : undefined,
            color: e.categoryColor,
            source: 'microsoft',
          })),
        ),
      );
    }

    // Outer timeout so a hung silent-refresh (Microsoft browser session
    // waiting on tenant consent) or a dead Graph endpoint surfaces as an
    // error instead of leaving the UI skeleton-forever.
    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      if (__DEV__) console.warn('[hooks] calendar fetch timed out');
      setState({
        items: [],
        loading: false,
        error: new Error('Kalender-forespørgslen tog for lang tid. Prøv igen.'),
      });
      cancelled = true;
    }, CALENDAR_FETCH_TIMEOUT_MS);

    Promise.all(tasks)
      .then((results) => {
        clearTimeout(timeoutId);
        if (cancelled) return;
        const merged = results
          .flat()
          .sort((a, b) => a.start.getTime() - b.start.getTime())
          .map((e, i) => ({ ...e, color: RIBBON_PALETTE[i % RIBBON_PALETTE.length] }));
        setState({ items: merged, loading: false, error: null });
      })
      .catch((err: Error) => {
        clearTimeout(timeoutId);
        if (cancelled) return;
        if (__DEV__) console.warn('[hooks] calendar fetch failed:', err.message);
        setState({ items: [], loading: false, error: err });
      });

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [googleAccessToken, microsoftAccessToken, user, rangeStartMs, rangeEndMs]);

  return state;
}

function useMailItems(): {
  items: NormalizedMail[];
  loading: boolean;
  error: Error | null;
} {
  const { googleAccessToken, microsoftAccessToken, user } = useAuth();
  const [state, setState] = useState<{
    items: NormalizedMail[];
    loading: boolean;
    error: Error | null;
  }>({ items: [], loading: false, error: null });

  useEffect(() => {
    if (!user || (!googleAccessToken && !microsoftAccessToken)) {
      setState({ items: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ items: [], loading: true, error: null });

    const tasks: Promise<NormalizedMail[]>[] = [];
    if (googleAccessToken) {
      tasks.push(
        listGmailMessages(12).then((msgs) =>
          msgs.map((m) => ({
            id: m.id,
            provider: 'google' as const,
            from: m.from,
            subject: m.subject,
            receivedAt: m.date,
            isRead: !m.unread,
            preview: m.snippet ?? '',
          })),
        ),
      );
    }
    if (microsoftAccessToken) {
      tasks.push(
        listGraphMessages(12).then((msgs) =>
          msgs.map((m) => ({
            id: m.id,
            provider: 'microsoft' as const,
            from: m.from,
            subject: m.subject,
            receivedAt: m.receivedAt,
            isRead: m.isRead,
            preview: m.preview ?? '',
          })),
        ),
      );
    }

    Promise.all(tasks)
      .then((results) => {
        if (cancelled) return;
        const merged = results
          .flat()
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
        setState({ items: merged, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (__DEV__) console.warn('[hooks] mail fetch failed:', err.message);
        setState({ items: [], loading: false, error: err });
      });

    return () => {
      cancelled = true;
    };
  }, [googleAccessToken, microsoftAccessToken, user]);

  return state;
}

export function useHasProvider(): boolean {
  const { googleAccessToken, microsoftAccessToken, user } = useAuth();
  if (isDemoUser(user)) return true;
  return !!(googleAccessToken || microsoftAccessToken);
}

function shortTime(then: Date, now: Date): string {
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();
  if (sameDay) return clockOf(then);
  const diffDays = Math.floor((now.getTime() - then.getTime()) / 86400000);
  if (diffDays < 7) return `${diffDays}d`;
  return `${pad(then.getDate())}/${pad(then.getMonth() + 1)}`;
}

export function useUpcoming(): Result<UpcomingEvent[]> & {
  todayMeetingCount: number;
  todayEvents: UpcomingEvent[];
} {
  const { user } = useAuth();
  const { items, loading, error } = useCalendarItems();
  if (isDemoUser(user)) {
    const demo = demoUpcoming();
    return {
      data: demo,
      loading: false,
      error: null,
      todayMeetingCount: demo.length,
      todayEvents: demo,
    };
  }
  const now = new Date();
  const toUpcoming = (e: NormalizedEvent, i: number): UpcomingEvent => ({
    id: e.id,
    time: e.allDay ? 'hele dagen' : clockOf(e.start),
    meta: relativeMeta(e.start, e.end, now),
    title: e.title,
    sub: e.location ?? durationLabel(e.start, e.end),
    tone: TONES[i % TONES.length],
    start: e.start,
    end: e.end,
    allDay: e.allDay ?? false,
    location: e.location,
    description: e.description,
    attendees: e.attendees,
    color: e.color,
    source: e.source,
  });
  const timedItems = items.filter((e) => !e.allDay);
  const todayMeetingCount = timedItems.length;
  const todayEvents = timedItems.map(toUpcoming);
  const data: UpcomingEvent[] = items
    .filter((e) => e.end.getTime() >= now.getTime())
    .map(toUpcoming);
  return { data, loading, error, todayMeetingCount, todayEvents };
}

// Persisted draft cache. In-memory Map keeps synchronous access for the hot
// path in useInboxWaiting; AsyncStorage keeps entries alive across cold
// starts so we don't regenerate a draft we already paid for on the last
// launch. Entries carry a TTL so stale drafts (archived mail, tone change
// etc.) age out instead of lingering indefinitely.
type DraftCacheEntry = { text: string; expiresAt: number };
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const DRAFT_STORAGE_KEY = 'zolva.mail.drafts';
const draftCache = new Map<string, DraftCacheEntry>();
let draftCacheHydrated = false;
let draftCacheHydrationPromise: Promise<void> | null = null;
let draftCacheWriteTimer: ReturnType<typeof setTimeout> | null = null;

async function hydrateDraftCache(): Promise<void> {
  if (draftCacheHydrated) return;
  if (draftCacheHydrationPromise) return draftCacheHydrationPromise;
  draftCacheHydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(DRAFT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, DraftCacheEntry>;
        const now = Date.now();
        for (const [k, v] of Object.entries(parsed)) {
          if (
            v &&
            typeof v.text === 'string' &&
            typeof v.expiresAt === 'number' &&
            v.expiresAt > now
          ) {
            draftCache.set(k, v);
          }
        }
      }
    } catch (err) {
      if (__DEV__) console.warn('[draft-cache] hydrate failed:', err);
    }
    draftCacheHydrated = true;
  })();
  return draftCacheHydrationPromise;
}

function persistDraftCacheSoon(): void {
  if (draftCacheWriteTimer) clearTimeout(draftCacheWriteTimer);
  draftCacheWriteTimer = setTimeout(() => {
    draftCacheWriteTimer = null;
    const snapshot: Record<string, DraftCacheEntry> = {};
    draftCache.forEach((v, k) => {
      snapshot[k] = v;
    });
    AsyncStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(snapshot)).catch((err) => {
      if (__DEV__) console.warn('[draft-cache] persist failed:', err);
    });
  }, 300);
}

function getDraftFromCache(key: string): string | undefined {
  const entry = draftCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    draftCache.delete(key);
    persistDraftCacheSoon();
    return undefined;
  }
  return entry.text;
}

function setDraftInCache(key: string, text: string): void {
  draftCache.set(key, { text, expiresAt: Date.now() + DRAFT_TTL_MS });
  persistDraftCacheSoon();
}

// The regex below is a cheap first-pass filter on the From address. It catches
// obvious automated senders (noreply@, mailer-daemon, Stripe receipts, etc.)
// without paying a Claude call, so we don't waste tokens classifying those.
// Mails that pass this filter go to the LLM classifier below for content-based
// verification before we spend an even bigger call drafting a reply.
const NO_REPLY_PATTERN =
  /noreply|no-reply|no_reply|donotreply|do-not-reply|mailer-daemon|bounce@|newsletter|marketing|notifications?@|alerts?@|updates?@|info@|support@|no-reply@accounts\.google\.com|(no-reply|receipts|notifications|invoice\+.*)@stripe\.com/i;

function needsReply(from: string): boolean {
  return !NO_REPLY_PATTERN.test(from);
}

// Reply-verdict cache. Classifier output is deterministic for a given mail,
// so we keep a persisted 24h cache to avoid re-paying on refresh / cold start.
// Separate from draftCache because verdicts are tone-agnostic (one entry per
// mail id) while drafts depend on the user's configured tone.
type VerdictCacheEntry = { needsReply: boolean; expiresAt: number };
const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
const VERDICT_STORAGE_KEY = 'zolva.mail.reply-verdicts';
const verdictCache = new Map<string, VerdictCacheEntry>();
let verdictCacheHydrated = false;
let verdictCacheHydrationPromise: Promise<void> | null = null;
let verdictCacheWriteTimer: ReturnType<typeof setTimeout> | null = null;

async function hydrateVerdictCache(): Promise<void> {
  if (verdictCacheHydrated) return;
  if (verdictCacheHydrationPromise) return verdictCacheHydrationPromise;
  verdictCacheHydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(VERDICT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, VerdictCacheEntry>;
        const now = Date.now();
        for (const [k, v] of Object.entries(parsed)) {
          if (
            v &&
            typeof v.needsReply === 'boolean' &&
            typeof v.expiresAt === 'number' &&
            v.expiresAt > now
          ) {
            verdictCache.set(k, v);
          }
        }
      }
    } catch (err) {
      if (__DEV__) console.warn('[verdict-cache] hydrate failed:', err);
    }
    verdictCacheHydrated = true;
  })();
  return verdictCacheHydrationPromise;
}

function persistVerdictCacheSoon(): void {
  if (verdictCacheWriteTimer) clearTimeout(verdictCacheWriteTimer);
  verdictCacheWriteTimer = setTimeout(() => {
    verdictCacheWriteTimer = null;
    const snapshot: Record<string, VerdictCacheEntry> = {};
    verdictCache.forEach((v, k) => {
      snapshot[k] = v;
    });
    AsyncStorage.setItem(VERDICT_STORAGE_KEY, JSON.stringify(snapshot)).catch((err) => {
      if (__DEV__) console.warn('[verdict-cache] persist failed:', err);
    });
  }, 300);
}

function getVerdictFromCache(id: string): boolean | undefined {
  const entry = verdictCache.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    verdictCache.delete(id);
    persistVerdictCacheSoon();
    return undefined;
  }
  return entry.needsReply;
}

function setVerdictInCache(id: string, needsReply: boolean): void {
  verdictCache.set(id, { needsReply, expiresAt: Date.now() + VERDICT_TTL_MS });
  persistVerdictCacheSoon();
}

const CLASSIFIER_SYSTEM_PROMPT =
  'You decide whether an incoming email warrants a human reply from the recipient. ' +
  'Answer YES only for messages from a real person that ask a question, make a request, ' +
  'invite the recipient, follow up on a conversation, or otherwise need a response to ' +
  'continue. Answer NO for: receipts, shipping or booking confirmations, login alerts, ' +
  'OTP and verification codes, marketing and newsletters, automated status notifications, ' +
  'calendar invites, subscription renewals, delivery updates, and anything that says ' +
  '"do not reply" in the body. When genuinely uncertain, answer YES — missing a real ' +
  'reply is worse than declining one.';

// Classifies one mail. Fails open: any error (network, rate limit, parse)
// returns true so the downstream draft call still runs, matching legacy
// over-drafting behavior on transient failures.
async function classifyNeedsReply(
  mail: NormalizedMail,
  signal: AbortSignal,
): Promise<boolean> {
  const preview = (mail.preview ?? '').slice(0, 400);
  try {
    const verdict = await completeJson<{ needsReply: boolean; reason?: string }>({
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `From: ${mail.from}\nSubject: ${mail.subject}\n\n${preview}`,
        },
      ],
      maxTokens: 80,
      temperature: 0.1,
      attachProfile: false,
      signal,
      schemaHint: '{"needsReply": boolean, "reason": "short phrase"}',
    });
    if (__DEV__) {
      console.log(
        `[classifier] ${mail.subject.slice(0, 40)} → ${verdict.needsReply ? 'REPLY' : 'SKIP'}${verdict.reason ? ` (${verdict.reason})` : ''}`,
      );
    }
    return verdict.needsReply;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    if (__DEV__) console.warn('[classifier] failed, failing open:', (err as Error).message);
    return true;
  }
}

const TONE_INSTRUCTIONS: Record<string, string> = {
  Kort: 'Skriv meget kort (én sætning). Neutral og direkte — ingen fyldord.',
  Venlig: 'Skriv kort (1-2 sætninger), venligt og imødekommende.',
  Formel: 'Skriv kort (1-2 sætninger), formelt og professionelt. Undgå slang.',
};

function draftSystemPrompt(tone: string): string {
  const toneLine = TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS.Venlig;
  return (
    `Du skriver et svar på en mail på vegne af brugeren. ${toneLine} Skriv altid på dansk. ` +
    'Lov aldrig konkrete datoer, tidspunkter, priser eller oplysninger du ikke kender. ' +
    'Undgå hilsen og underskrift — skriv kun selve svaret. Returnér kun udkastet, uden anførselstegn eller kommentarer.'
  );
}

const AUTONOMY_TARGETS: Record<string, number> = {
  'Spørg altid': 0,
  'Lav udkast': 3,
  'Handl selv': 6,
};

// Drafts are user-facing Danish copy — Sonnet 4.6 is meaningfully better at
// tone calibration and Danish phrasing than Haiku. Cost delta is small since
// drafts are ~160 tokens each and only a handful run per inbox refresh.
const DRAFT_MODEL = 'claude-sonnet-4-6';

async function generateDraft(
  mail: NormalizedMail,
  tone: string,
  signal: AbortSignal,
): Promise<string> {
  return complete({
    model: DRAFT_MODEL,
    system: draftSystemPrompt(tone),
    messages: [
      {
        role: 'user',
        content: `Fra: ${mail.from}\nEmne: ${mail.subject}\n\nSkriv et kort svar på dansk.`,
      },
    ],
    maxTokens: 160,
    temperature: 0.6,
    signal,
  });
}

export function useInboxWaiting(): Result<InboxMail[]> {
  const { user } = useAuth();
  const demo = isDemoUser(user);
  const { items, loading, error } = useMailItems();
  const dismissed = useDismissedMailIds();
  const { data: workRows } = useWorkPreferences();
  const autonomy = prefValue(workRows, 'autonomy');
  const tone = prefValue(workRows, 'tone');
  const quietHours = prefValue(workRows, 'quiet-hours');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (demo) return;
    if (!hasClaudeKey() || items.length === 0) return;
    if (isInQuietHours(quietHours, new Date())) return;

    const maxDrafts = AUTONOMY_TARGETS[autonomy] ?? AUTONOMY_TARGETS['Lav udkast'];
    if (maxDrafts === 0) return;

    const targets = items
      .filter((m) => !m.isRead && !dismissed.has(m.id) && needsReply(m.from))
      .slice(0, maxDrafts);
    if (targets.length === 0) return;

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const draftKey = (id: string) => `${id}::${tone || 'default'}`;

    // Wait for both persisted caches to hydrate — otherwise every cold launch
    // re-pays for classifications and drafts AsyncStorage already has.
    void Promise.all([hydrateDraftCache(), hydrateVerdictCache()]).then(async () => {
      if (controller.signal.aborted) return;

      // Classification pass: short-circuit cached verdicts, classify the rest
      // in parallel. Cached positives go straight into the draft pipeline
      // below; cached negatives are dropped before any draft call.
      const awaitingClassification: NormalizedMail[] = [];
      const confirmedTargets: NormalizedMail[] = [];
      for (const m of targets) {
        const verdict = getVerdictFromCache(m.id);
        if (verdict === true) confirmedTargets.push(m);
        else if (verdict === undefined) awaitingClassification.push(m);
        // verdict === false → skip entirely
      }

      if (awaitingClassification.length > 0) {
        const results = await Promise.all(
          awaitingClassification.map((m) =>
            classifyNeedsReply(m, controller.signal)
              .then((needs) => {
                setVerdictInCache(m.id, needs);
                return needs ? m : null;
              })
              .catch((err: Error) => {
                if (err.name !== 'AbortError' && __DEV__) {
                  console.warn('[hooks] classifier failed:', err.message);
                }
                // Fail open on unexpected errors — caller of classifyNeedsReply
                // already swallows non-abort errors, so reaching here means abort.
                return null;
              }),
          ),
        );
        if (controller.signal.aborted) return;
        for (const m of results) if (m) confirmedTargets.push(m);
      }

      if (confirmedTargets.length === 0) return;

      const cached: Record<string, string> = {};
      const pending: NormalizedMail[] = [];
      for (const m of confirmedTargets) {
        const hit = getDraftFromCache(draftKey(m.id));
        if (hit) cached[m.id] = hit;
        else pending.push(m);
      }
      if (Object.keys(cached).length > 0) {
        setDrafts((prev) => ({ ...prev, ...cached }));
      }
      if (pending.length === 0) return;

      const results = await Promise.all(
        pending.map((m) =>
          generateDraft(m, tone, controller.signal)
            .then((text) => {
              if (!text) return null;
              setDraftInCache(draftKey(m.id), text);
              return [m.id, text] as const;
            })
            .catch((err: Error) => {
              if (err.name !== 'AbortError' && __DEV__) {
                console.warn('[hooks] draft generation failed:', err.message);
              }
              return null;
            }),
        ),
      );
      if (controller.signal.aborted) return;
      const next: Record<string, string> = {};
      for (const r of results) if (r) next[r[0]] = r[1];
      if (Object.keys(next).length > 0) {
        setDrafts((prev) => ({ ...prev, ...next }));
      }
    });

    return () => controller.abort();
  }, [demo, items, autonomy, tone, quietHours]);

  if (demo) {
    return {
      data: demoInboxWaiting().filter((m) => !dismissed.has(m.id)),
      loading: false,
      error: null,
    };
  }

  const now = new Date();
  const tones: InboxMail['tone'][] = ['sage', 'clay', 'mist'];
  const data: InboxMail[] = items
    .filter((m) => !m.isRead && !dismissed.has(m.id))
    .slice(0, 12)
    .map((m, i) => ({
      id: m.id,
      provider: m.provider,
      from: m.from,
      subject: m.subject,
      time: shortTime(m.receivedAt, now),
      tone: tones[i % tones.length],
      initials: initialsOf(m.from),
      aiDraft: drafts[m.id] ?? null,
    }));
  return { data, loading, error };
}

export function useInboxArchived(): Result<InboxMail[]> {
  const { user } = useAuth();
  const { items, loading, error } = useMailItems();
  const dismissed = useDismissedMailIds();
  if (isDemoUser(user)) {
    const base = demoInboxArchived();
    const justDismissed = demoInboxWaiting().filter((m) => dismissed.has(m.id));
    return {
      data: [...justDismissed, ...base],
      loading: false,
      error: null,
    };
  }
  const now = new Date();
  const tones: InboxMail['tone'][] = ['sage', 'clay', 'mist'];
  const data: InboxMail[] = items
    .filter((m) => m.isRead || dismissed.has(m.id))
    .map((m, i) => ({
      id: m.id,
      provider: m.provider,
      from: m.from,
      subject: m.subject,
      time: shortTime(m.receivedAt, now),
      tone: tones[i % tones.length],
      initials: initialsOf(m.from),
      aiDraft: null,
    }));
  return { data, loading, error };
}

export function useInboxCleared(): Result<{ items: DoneMail[]; count: number }> {
  const { user } = useAuth();
  const { items, loading, error } = useMailItems();
  const dismissed = useDismissedMailIds();
  if (isDemoUser(user)) {
    const base = demoInboxCleared();
    const justDismissed = demoInboxWaiting()
      .filter((m) => dismissed.has(m.id))
      .map((m) => ({ id: m.id, from: m.from, note: m.subject }));
    return {
      data: {
        items: [...justDismissed, ...base.items].slice(0, 6),
        count: base.count + justDismissed.length,
      },
      loading: false,
      error: null,
    };
  }
  const cleared = items.filter((m) => m.isRead || dismissed.has(m.id));
  const data = {
    items: cleared.slice(0, 6).map((m) => ({
      id: m.id,
      from: m.from,
      note: m.subject,
    })),
    count: cleared.length,
  };
  return { data, loading, error };
}

export function useMailDetail(
  id: string | null,
  provider: MailProvider | null,
): Result<MailDetail | null> {
  const { user } = useAuth();
  const demo = isDemoUser(user);
  const [state, setState] = useState<Result<MailDetail | null>>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!id || !provider) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    if (demo) {
      setState({ data: demoMailDetail(id), loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });

    const task =
      provider === 'google'
        ? gmailGetMessageBody(id).then((b): MailDetail => ({
            id: b.id,
            provider: 'google',
            from: b.from,
            subject: b.subject,
            body: b.text,
            replyContext: {
              provider: 'google',
              threadId: b.threadId,
              messageIdHeader: b.messageIdHeader,
              references: b.references,
              replyTo: b.fromEmail,
              subject: b.subject,
            },
          }))
        : graphGetMessageBody(id).then((b): MailDetail => ({
            id: b.id,
            provider: 'microsoft',
            from: b.from,
            subject: b.subject,
            body: b.text,
            replyContext: { provider: 'microsoft', messageId: b.id },
          }));

    task
      .then((detail) => {
        if (cancelled) return;
        setState({ data: detail, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (__DEV__) console.warn('[hooks] mail detail failed:', err.message);
        setState({ data: null, loading: false, error: err });
      });

    return () => {
      cancelled = true;
    };
  }, [id, provider, demo]);

  return state;
}

export function useSendReply() {
  const { user } = useAuth();
  const demo = isDemoUser(user);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const send = useCallback(
    async (mailId: string, body: string, ctx: ReplyContext): Promise<boolean> => {
      setSending(true);
      setError(null);
      if (demo) {
        await new Promise((r) => setTimeout(r, 400));
        markMailDismissed(mailId);
        setSending(false);
        return true;
      }
      try {
        if (ctx.provider === 'google') {
          await gmailSendReply({
            threadId: ctx.threadId,
            to: ctx.replyTo,
            subject: ctx.subject,
            inReplyTo: ctx.messageIdHeader,
            references: ctx.references,
            body,
          });
        } else {
          await graphReplyToMessage(ctx.messageId, body);
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (__DEV__) console.warn('[hooks] send reply failed:', e.message);
        setError(e);
        setSending(false);
        return false;
      }

      // Send succeeded. Archive is best-effort — a failure here still counts
      // as success because the reply went out.
      try {
        if (ctx.provider === 'google') {
          await gmailArchiveMessage(mailId);
        } else {
          await graphArchiveMessage(mailId);
        }
      } catch (err) {
        if (__DEV__) console.warn('[hooks] archive after send failed:', err);
      }

      markMailDismissed(mailId);
      setSending(false);
      return true;
    },
    [demo],
  );

  const archive = useCallback(
    async (mailId: string, provider: MailProvider): Promise<boolean> => {
      setSending(true);
      setError(null);
      if (demo) {
        await new Promise((r) => setTimeout(r, 200));
        markMailDismissed(mailId);
        setSending(false);
        return true;
      }
      try {
        if (provider === 'google') {
          await gmailArchiveMessage(mailId);
        } else {
          await graphArchiveMessage(mailId);
        }
        markMailDismissed(mailId);
        setSending(false);
        return true;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (__DEV__) console.warn('[hooks] archive failed:', e.message);
        setError(e);
        setSending(false);
        return false;
      }
    },
    [demo],
  );

  return { send, archive, sending, error };
}

// Day grid runs 06:00 → 05:00 next morning. Encoded as 6..30 so the
// expansion math stays linear; makeHourSlots folds the label back with
// (hour % 24). Hours 00..05 display at the end of the grid as the
// "after-midnight" tail of the day.
const DEFAULT_GRID_START_HOUR = 6;
const DEFAULT_GRID_END_HOUR = 30;
const ABSOLUTE_START_HOUR = 0;
const ABSOLUTE_END_HOUR = 30;

const slotTones: ('sage' | 'clay' | 'mist')[] = ['sage', 'clay', 'mist'];

function makeHourSlots(startHour: number, endHour: number): CalendarSlot[] {
  const count = Math.max(0, endHour - startHour);
  return Array.from({ length: count }, (_, i) => ({
    hour: String((startHour + i) % 24).padStart(2, '0'),
    event: null,
  }));
}

function describeTimedEvent(e: NormalizedEvent, tone: 'sage' | 'clay' | 'mist') {
  return {
    id: e.id,
    title: e.title,
    sub: e.location
      ? `${e.location} · ${durationLabel(e.start, e.end)}`
      : durationLabel(e.start, e.end),
    tone,
  };
}

export function useDaySchedule(targetDate?: Date): Result<CalendarSlot[]> {
  const { user } = useAuth();
  const bounds = targetDate ? dayBounds(targetDate) : undefined;
  const { items, loading, error } = useCalendarItems(
    bounds?.start.getTime(),
    bounds?.end.getTime(),
  );
  if (isDemoUser(user)) {
    return { data: demoDaySchedule(), loading: false, error: null };
  }

  const allDay = items.filter((e) => e.allDay);
  const timed = items.filter((e) => !e.allDay);

  // Expand the grid window so every timed event has a home. Hours
  // before DEFAULT_GRID_START_HOUR get shifted up by 24 so they sit in
  // the after-midnight tail of the wrap window.
  let startHour = DEFAULT_GRID_START_HOUR;
  let endHour = DEFAULT_GRID_END_HOUR;
  for (const e of timed) {
    const sh = e.start.getHours();
    const effStart = sh >= DEFAULT_GRID_START_HOUR ? sh : sh + 24;
    startHour = Math.max(ABSOLUTE_START_HOUR, Math.min(startHour, effStart));
    // Round the end-hour up when there are minutes left, so a 09:45-10:15
    // meeting contributes an 11 bound and the 10 slot stays visible.
    const eh = e.end.getHours();
    const rawEnd = eh + (e.end.getMinutes() > 0 ? 1 : 0);
    const effEnd = rawEnd >= DEFAULT_GRID_START_HOUR ? rawEnd : rawEnd + 24;
    endHour = Math.min(ABSOLUTE_END_HOUR, Math.max(endHour, effEnd, effStart + 1));
  }

  // On today, ensure the current hour has a row so the now-line has
  // something to anchor to even if no event runs that late (or early).
  if (targetDate) {
    const now = new Date();
    if (
      targetDate.getFullYear() === now.getFullYear() &&
      targetDate.getMonth() === now.getMonth() &&
      targetDate.getDate() === now.getDate()
    ) {
      const nh = now.getHours();
      const effNow = nh >= DEFAULT_GRID_START_HOUR ? nh : nh + 24;
      startHour = Math.max(ABSOLUTE_START_HOUR, Math.min(startHour, effNow));
      endHour = Math.min(ABSOLUTE_END_HOUR, Math.max(endHour, effNow + 1));
    }
  }

  const hourSlots = makeHourSlots(startHour, endHour);
  timed.forEach((e, i) => {
    const h = e.start.getHours();
    // Hours before DEFAULT_GRID_START_HOUR belong to the after-midnight
    // tail of the wrap window; shift them up by 24 so the slot index math
    // lands in the second half of the grid.
    const effHour = h >= DEFAULT_GRID_START_HOUR ? h : h + 24;
    const idx = effHour - startHour;
    if (idx < 0 || idx >= hourSlots.length) return;
    hourSlots[idx] = {
      hour: hourSlots[idx].hour,
      event: describeTimedEvent(e, slotTones[i % slotTones.length]),
    };
  });

  // All-day events pin above the hourly grid so multi-day holidays,
  // birthdays, and OOO blocks never get dropped.
  const allDaySlots: CalendarSlot[] = allDay.map((e, i) => ({
    hour: '—',
    event: {
      id: e.id,
      title: e.title,
      sub: e.location ?? 'Hele dagen',
      tone: slotTones[i % slotTones.length],
    },
  }));

  return { data: [...allDaySlots, ...hourSlots], loading, error };
}

const DEFAULT_CONNECTIONS: Connection[] = [
  { id: 'google-calendar', title: 'Google Kalender', sub: 'Læser & opretter begivenheder', status: 'disconnected', logo: 'google-calendar.png' },
  { id: 'gmail', title: 'Gmail', sub: 'Søger, læser og sender', status: 'disconnected', logo: 'gmail.png' },
  { id: 'google-drive', title: 'Google Drive', sub: 'Søger og læser tekstfiler', status: 'disconnected', logo: 'google-drive.png' },
  { id: 'outlook-calendar', title: 'Outlook Kalender', sub: 'Microsoft 365', status: 'disconnected', logo: 'outlook-calendar.png' },
  { id: 'outlook-mail', title: 'Outlook Mail', sub: 'Microsoft 365', status: 'disconnected', logo: 'outlook-mail.png' },
];

const GOOGLE_INTEGRATIONS = new Set<Connection['id']>(['google-calendar', 'gmail', 'google-drive']);
const MICROSOFT_INTEGRATIONS = new Set<Connection['id']>(['outlook-calendar', 'outlook-mail']);

export function useConnections() {
  const {
    user,
    googleAccessToken,
    microsoftAccessToken,
    signInWithGoogle,
    signInWithMicrosoft,
    disconnectProvider,
  } = useAuth();
  const demo = isDemoUser(user);

  const data: Connection[] = demo
    ? DEMO_CONNECTIONS
    : DEFAULT_CONNECTIONS.map((c) => {
        if (GOOGLE_INTEGRATIONS.has(c.id) && googleAccessToken) {
          return { ...c, status: 'connected' as const };
        }
        if (MICROSOFT_INTEGRATIONS.has(c.id) && microsoftAccessToken) {
          return { ...c, status: 'connected' as const };
        }
        return c;
      });

  const connect = async (id: Connection['id']) => {
    if (demo) return { data: null, error: null };
    if (GOOGLE_INTEGRATIONS.has(id)) return signInWithGoogle();
    if (MICROSOFT_INTEGRATIONS.has(id)) return signInWithMicrosoft();
    return { data: null, error: new Error('Ukendt integration.') };
  };

  const disconnect = async (id: Connection['id']): Promise<{ error: Error | null }> => {
    try {
      if (GOOGLE_INTEGRATIONS.has(id)) await disconnectProvider('google');
      else if (MICROSOFT_INTEGRATIONS.has(id)) await disconnectProvider('microsoft');
      else return { error: new Error('Ukendt integration.') };
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  };

  return { data, loading: false, error: null as Error | null, connect, disconnect };
}

function prefValue(rows: WorkPreference[], id: WorkPreferenceId): string {
  return rows.find((r) => r.id === id)?.value ?? '';
}

function isInQuietHours(value: string, now: Date): boolean {
  if (!value || value === 'Fra') return false;
  const m = value.match(/^(\d{1,2})[–-](\d{1,2})$/);
  if (!m) return false;
  const from = parseInt(m[1], 10);
  const to = parseInt(m[2], 10);
  const h = now.getHours();
  return from > to ? h >= from || h < to : h >= from && h < to;
}

function isMorningBriefReady(value: string, now: Date): boolean {
  if (!value || value === 'Fra') return false;
  const m = value.match(/^(\d{1,2})\.(\d{2})$/);
  if (!m) return true;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

const DEFAULT_WORK_PREFERENCES: WorkPreference[] = [
  {
    id: 'autonomy',
    title: 'Autonomi',
    meta: 'Hvor meget Zolva må gøre på egen hånd',
    value: 'Lav udkast',
    options: ['Spørg altid', 'Lav udkast', 'Handl selv'],
  },
  {
    id: 'tone',
    title: 'Tone i mails',
    meta: 'Stil og sprog',
    value: 'Venlig',
    options: ['Kort', 'Venlig', 'Formel'],
  },
  {
    id: 'morning-brief',
    title: 'Morgenoverblik',
    meta: 'Daglig opsummering',
    value: '08.00',
    options: ['Fra', '07.00', '08.00', '09.00'],
  },
  {
    id: 'quiet-hours',
    title: 'Stille timer',
    meta: 'Ingen notifikationer',
    value: '22–07',
    options: ['Fra', '22–07', '21–08', '23–06'],
  },
  {
    id: 'evening-brief',
    title: 'Aftenoverblik',
    meta: 'Daglig opsummering om aftenen',
    value: 'Fra',
    options: ['Fra', '17.00', '18.00', '19.00'],
  },
];

const workPrefsKey = (uid: string) => `zolva.${uid}.prefs.work`;

function applySavedPrefs(
  prev: WorkPreference[],
  saved: Record<string, string>,
): WorkPreference[] {
  return prev.map((r) => (saved[r.id] ? { ...r, value: saved[r.id] } : r));
}

export type SetWorkPreferenceResult =
  | { ok: true }
  | { ok: false; reason: 'unauthenticated' | 'rls' | 'error'; message?: string };

export function useWorkPreferences() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const demo = isDemoUser(user);
  const [rows, setRows] = useState<WorkPreference[]>(DEFAULT_WORK_PREFERENCES);

  useEffect(() => {
    setRows(DEFAULT_WORK_PREFERENCES);
    if (!userId) return;
    let cancelled = false;
    AsyncStorage.getItem(workPrefsKey(userId)).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const saved = JSON.parse(raw) as Record<WorkPreferenceId, string>;
        setRows((prev) => applySavedPrefs(prev, saved));
      } catch {}
    });
    if (!demo) {
      supabase
        .from('work_preferences')
        .select('id, value')
        .eq('user_id', userId)
        .then(({ data, error }) => {
          if (cancelled || error || !data) return;
          const saved = Object.fromEntries(
            data.map((r) => [r.id as string, r.value as string]),
          );
          setRows((prev) => {
            const next = applySavedPrefs(prev, saved);
            const snapshot = Object.fromEntries(next.map((r) => [r.id, r.value]));
            AsyncStorage.setItem(workPrefsKey(userId), JSON.stringify(snapshot)).catch(() => {});
            return next;
          });
          if (data.length === 0) {
            const nowIso = new Date().toISOString();
            const seed = DEFAULT_WORK_PREFERENCES.map((r) => ({
              user_id: userId,
              id: r.id,
              value: r.value,
              updated_at: nowIso,
            }));
            void supabase
              .from('work_preferences')
              .upsert(seed, { onConflict: 'user_id,id' })
              .then(({ error: seedError }) => {
                if (seedError && __DEV__) {
                  console.warn('[work-prefs] seed failed:', seedError.message);
                }
              });
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [userId, demo]);

  const setValue = useCallback(
    async (id: WorkPreferenceId, value: string): Promise<SetWorkPreferenceResult> => {
      if (!userId) return { ok: false, reason: 'unauthenticated' };

      let previousValue: string | null | undefined;
      let previousSnapshot: Record<string, string | null> | undefined;
      setRows((prev) => {
        previousValue = prev.find((r) => r.id === id)?.value;
        previousSnapshot = Object.fromEntries(prev.map((r) => [r.id, r.value]));
        const next = prev.map((r) => (r.id === id ? { ...r, value } : r));
        const snapshot = Object.fromEntries(next.map((r) => [r.id, r.value]));
        AsyncStorage.setItem(workPrefsKey(userId), JSON.stringify(snapshot)).catch(() => {});
        return next;
      });

      if (demo) return { ok: true };

      const { data, error } = await supabase
        .from('work_preferences')
        .upsert(
          { user_id: userId, id, value, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,id' },
        )
        .select('id');

      const rowsAffected = data?.length ?? 0;
      if (error || rowsAffected === 0) {
        if (__DEV__) {
          console.warn(
            '[work-prefs] upsert failed:',
            error?.message ?? `0 rows affected (RLS/session?)`,
          );
        }
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, value: previousValue ?? r.value } : r)),
        );
        if (previousSnapshot) {
          AsyncStorage.setItem(workPrefsKey(userId), JSON.stringify(previousSnapshot)).catch(
            () => {},
          );
        }
        return error
          ? { ok: false, reason: 'error', message: error.message }
          : { ok: false, reason: 'rls' };
      }

      return { ok: true };
    },
    [userId, demo],
  );

  return { data: rows, loading: false, error: null as Error | null, setValue };
}

export type PrivacyFlagId =
  | 'training-opt-in'
  | 'local-only'
  | 'anon-reports'
  | 'memory-enabled';

const PRIVACY_DEFAULTS: Record<PrivacyFlagId, boolean> = {
  'training-opt-in': false,
  'local-only': true,
  'anon-reports': true,
  'memory-enabled': false,
};

const DEFAULT_PRIVACY_TOGGLES: PrivacyToggle[] = [
  { id: 'training-opt-in', label: 'Brug mine data til at forbedre Zolva', enabled: PRIVACY_DEFAULTS['training-opt-in'] },
  { id: 'local-only', label: 'Gem samtaler lokalt', enabled: PRIVACY_DEFAULTS['local-only'] },
  { id: 'anon-reports', label: 'Del fejlrapporter anonymt', enabled: PRIVACY_DEFAULTS['anon-reports'] },
  { id: 'memory-enabled', label: 'Lad Zolva lære dig at kende', enabled: PRIVACY_DEFAULTS['memory-enabled'] },
];

const privacyTogglesKey = (uid: string) => `zolva.${uid}.prefs.privacy`;

// Module-level cache so non-hook code (useChat side effects, API calls)
// can read flags synchronously. Reset + rehydrated whenever the active
// user changes so flags never leak across accounts.
let privacyCache: Partial<Record<PrivacyFlagId, boolean>> = {};
let privacyHydrated = false;
let privacyHydrationPromise: Promise<void> | null = null;
let privacyUid: string | null = null;
let privacyUserSubscribed = false;

const privacyListeners = new Set<() => void>();
function notifyPrivacyChange() {
  privacyListeners.forEach((l) => l());
}

function ensurePrivacyUserSubscription() {
  if (privacyUserSubscribed) return;
  privacyUserSubscribed = true;
  subscribeUserId((uid) => {
    if (uid === privacyUid) return;
    privacyUid = uid;
    privacyCache = {};
    privacyHydrated = false;
    privacyHydrationPromise = null;
    notifyPrivacyChange();
  });
}

export function getPrivacyFlag(id: PrivacyFlagId): boolean {
  const cached = privacyCache[id];
  return cached === undefined ? PRIVACY_DEFAULTS[id] : cached;
}

export async function hydratePrivacyCache(): Promise<void> {
  ensurePrivacyUserSubscription();
  if (privacyHydrated) return;
  if (privacyHydrationPromise) return privacyHydrationPromise;
  const uid = privacyUid;
  if (!uid) {
    privacyHydrated = true;
    return;
  }
  privacyHydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(privacyTogglesKey(uid));
      if (uid !== privacyUid) return;
      if (raw) privacyCache = JSON.parse(raw) as Partial<Record<PrivacyFlagId, boolean>>;
    } catch {}
    if (uid === privacyUid) privacyHydrated = true;
  })().finally(() => {
    privacyHydrationPromise = null;
  });
  return privacyHydrationPromise;
}

export function usePrivacyToggles() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [toggles, setToggles] = useState<PrivacyToggle[]>(DEFAULT_PRIVACY_TOGGLES);

  useEffect(() => {
    setToggles(DEFAULT_PRIVACY_TOGGLES);
    if (!userId) return;
    let cancelled = false;
    hydratePrivacyCache().then(() => {
      if (cancelled) return;
      setToggles((prev) =>
        prev.map((t) => {
          const saved = privacyCache[t.id as PrivacyFlagId];
          return saved === undefined ? t : { ...t, enabled: saved };
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const flip = useCallback(
    (id: string) => {
      setToggles((prev) => {
        const next = prev.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t));
        const snapshot = Object.fromEntries(next.map((t) => [t.id, t.enabled])) as Partial<
          Record<PrivacyFlagId, boolean>
        >;
        privacyCache = snapshot;
        privacyHydrated = true;
        if (userId) {
          AsyncStorage.setItem(privacyTogglesKey(userId), JSON.stringify(snapshot)).catch(() => {});
        }
        return next;
      });
      notifyPrivacyChange();
    },
    [userId],
  );

  return { data: toggles, loading: false, error: null as Error | null, flip };
}

export function useReminders() {
  const { user } = useAuth();
  const demo = isDemoUser(user);
  const [reminders, setReminders] = useState<Reminder[]>(() =>
    isDemoUser(user) ? demoReminders() : listReminders(),
  );
  useEffect(() => {
    if (demo) {
      setReminders(demoReminders());
      return;
    }
    return subscribeReminders(setReminders);
  }, [demo]);
  const markDone = useCallback(
    (id: string) => {
      if (demo) {
        setReminders((prev) =>
          prev.map((r) =>
            r.id === id ? { ...r, status: 'done' as const, doneAt: new Date() } : r,
          ),
        );
        return;
      }
      void storeMarkReminderDone(id);
    },
    [demo],
  );
  const remove = useCallback(
    (id: string) => {
      if (demo) {
        setReminders((prev) => prev.filter((r) => r.id !== id));
        return;
      }
      void storeRemoveReminder(id);
    },
    [demo],
  );
  const add = useCallback(
    (text: string, dueAt?: Date): Promise<Reminder> => {
      if (demo) {
        const r: Reminder = {
          id: `d-r-${Date.now()}`,
          text,
          dueAt: dueAt ?? null,
          status: 'pending',
          createdAt: new Date(),
          doneAt: null,
        };
        setReminders((prev) => [...prev, r]);
        return Promise.resolve(r);
      }
      return storeAddReminder(text, dueAt);
    },
    [demo],
  );
  return {
    data: reminders,
    loading: false,
    error: null as Error | null,
    markDone,
    remove,
    add,
  };
}

export function useNotes() {
  const { user } = useAuth();
  const demo = isDemoUser(user);
  const [notes, setNotes] = useState<Note[]>(() =>
    isDemoUser(user) ? demoNotes() : listNotes(),
  );
  useEffect(() => {
    if (demo) {
      setNotes(demoNotes());
      return;
    }
    return subscribeNotes(setNotes);
  }, [demo]);
  const remove = useCallback(
    (id: string) => {
      if (demo) {
        setNotes((prev) => prev.filter((n) => n.id !== id));
        return;
      }
      void storeRemoveNote(id);
    },
    [demo],
  );
  const add = useCallback(
    (text: string): Promise<Note> => {
      if (demo) {
        const n: Note = {
          id: `d-n-${Date.now()}`,
          text,
          category: 'note',
          createdAt: new Date(),
        };
        setNotes((prev) => [...prev, n]);
        return Promise.resolve(n);
      }
      return storeAddNote(text);
    },
    [demo],
  );
  return {
    data: notes,
    loading: false,
    error: null as Error | null,
    remove,
    add,
  };
}

// Entries are hidden until their `firesAt` passes — scheduled-but-not-yet-
// fired notifications shouldn't appear in the feed.
function visibleFeed(entries: FeedEntry[], now: number): FeedEntry[] {
  return entries
    .filter((e) => e.firesAt.getTime() <= now)
    .sort((a, b) => b.firesAt.getTime() - a.firesAt.getTime());
}

export function useNotificationFeed() {
  const [entries, setEntries] = useState<FeedEntry[]>(() => listFeedEntries());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => subscribeFeed(setEntries), []);

  // Tick the cutoff forward so entries scheduled in the near future reveal
  // themselves without needing a manual refresh.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const visible = visibleFeed(entries, now);
  const markRead = useCallback((id: string) => {
    void markFeedEntryRead(id);
  }, []);
  const markAll = useCallback(() => {
    void markAllFeedRead();
  }, []);

  return {
    data: visible,
    loading: false,
    error: null as Error | null,
    markRead,
    markAll,
  };
}

export function useUnreadNotificationCount(): number {
  const [entries, setEntries] = useState<FeedEntry[]>(() => listFeedEntries());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeFeed(setEntries), []);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);
  return entries.filter((e) => e.readAt == null && e.firesAt.getTime() <= now).length;
}

const chatHistoryKey = (uid: string) => `zolva.${uid}.chat.history`;
const CHAT_HISTORY_LIMIT = 50;
// The model can't meaningfully use the full 50-message window. Only the most
// recent turns carry context the next reply depends on — cap what we send to
// Claude to keep input tokens flat as the local transcript grows.
const CHAT_API_CONTEXT_LIMIT = 15;
const CHAT_ERROR_TEXT = 'Jeg kunne ikke nå frem — prøv igen.';

function buildChatSystemPrompt(name: string): string {
  const intro = name ? `Brugerens navn er ${name}.` : '';
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzOffsetMin = -now.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(tzOffsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  const offsetIso = `${sign}${hh}:${mm}`;
  const pad = (n: number) => String(n).padStart(2, '0');
  const localIso =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetIso}`;
  const timeContext =
    `Nuværende lokaltid er ${localIso} (tidszone: ${tz}). ` +
    'Når du udregner due_at for add_reminder, skal tidspunktet altid ligge i fremtiden ' +
    'regnet fra dette tidspunkt. Brug ISO 8601 med samme tidszone-offset. ' +
    'Hvis brugeren siger "om 2 minutter", læg 2 minutter til nu. Hvis brugeren siger ' +
    '"kl. 10.30" uden dato, vælg den næste fremtidige forekomst (i dag hvis klokken ' +
    'endnu ikke er 10.30, ellers i morgen).';
  return [
    'Du er Zolva, en venlig og omsorgsfuld dansk personlig assistent.',
    'Du svarer altid på dansk i en varm, jordnær og let uformel tone.',
    intro,
    timeContext,
    'Hold svar korte, konkrete og handlingsorienterede, medmindre der bliver spurgt om detaljer.',
    'Når brugeren beder dig huske noget tidsbundet (et møde, en opgave med deadline), brug add_reminder.',
    'VIGTIGT om add_reminder: hvis brugeren beder om en påmindelse uden at angive et konkret tidspunkt, ' +
      'så spørg dem først hvornår de vil mindes — fx "Hvornår skal jeg minde dig om det?". ' +
      'Kald først add_reminder når brugeren har bekræftet et tidspunkt, ELLER hvis brugeren ' +
      'eksplicit siger "uden tidspunkt" / "når som helst" / "ingen bestemt tid" — i det tilfælde ' +
      'kald add_reminder uden due_at, og fortæl brugeren at du minder dem løbende indtil de markerer den som klaret.',
    'Brug ALDRIG nuværende lokaltid eller "om lidt" som standard-tidspunkt — det skal komme fra brugeren.',
    'Når brugeren beder dig notere en idé, en tanke eller noget uden tid, brug add_note.',
    'Brug list_reminders og list_notes hvis brugeren spørger hvad du har gemt.',
    'Kald værktøjer FØR du bekræfter — bekræft først når værktøjet faktisk er kørt.',
  ]
    .filter(Boolean)
    .join(' ');
}

function toClaudeMessages(messages: ChatMessage[]): ClaudeMessage[] {
  return messages.slice(-CHAT_API_CONTEXT_LIMIT).map((m) => ({
    role: m.from === 'user' ? 'user' : 'assistant',
    content: m.text,
  }));
}

const CHAT_TOOLS: ClaudeToolSchema[] = [
  {
    name: 'add_reminder',
    description:
      'Gem en påmindelse for brugeren. Brug når brugeren beder dig huske noget tidsbundet.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Hvad der skal huskes, på dansk.' },
        due_at: {
          type: 'string',
          description:
            'ISO 8601 dato/tid for påmindelsen med tidszone-offset (fx "2026-04-19T23:45:00+02:00"). Skal ligge i fremtiden regnet fra det nuværende tidspunkt. Udelad hvis brugeren ikke har angivet et tidspunkt.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'add_note',
    description: 'Gem en note uden tidspunkt. Brug når brugeren vil notere en idé eller tanke.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Notens indhold, på dansk.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_reminders',
    description: 'Hent brugerens aktuelle påmindelser.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_notes',
    description: 'Hent brugerens aktuelle noter.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function runChatTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === 'add_reminder') {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim()) return { content: 'Manglede tekst.', isError: true };
      const dueRaw = typeof input.due_at === 'string' ? input.due_at : undefined;
      const due = dueRaw ? new Date(dueRaw) : undefined;
      const dueClean = due && !Number.isNaN(due.getTime()) ? due : undefined;
      const r = await storeAddReminder(text, dueClean);
      return { content: `Oprettet påmindelse ${r.id}: "${r.text}"${r.dueAt ? ` til ${r.dueAt.toISOString()}` : ''}.`, isError: false };
    }
    if (name === 'add_note') {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim()) return { content: 'Manglede tekst.', isError: true };
      const n = await storeAddNote(text);
      return { content: `Oprettet note ${n.id}: "${n.text}".`, isError: false };
    }
    if (name === 'list_reminders') {
      const rs = listReminders();
      if (rs.length === 0) return { content: 'Ingen påmindelser gemt.', isError: false };
      return {
        content: rs
          .map((r) => `${r.id} [${r.status}] ${r.dueAt ? r.dueAt.toISOString() : 'ingen tid'}: ${r.text}`)
          .join('\n'),
        isError: false,
      };
    }
    if (name === 'list_notes') {
      const ns = listNotes();
      if (ns.length === 0) return { content: 'Ingen noter gemt.', isError: false };
      return { content: ns.map((n) => `${n.id}: ${n.text}`).join('\n'), isError: false };
    }
    return { content: `Ukendt værktøj: ${name}`, isError: true };
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

const CHAT_TOOL_ROUND_CAP = 2;

// ─── Chat suggestion chips ─────────────────────────────────────────────────

type SuggestionCacheEntry = { expiresAt: number; data: string[] };
const SUGGESTION_TTL_MS = 15 * 60 * 1000;
const SUGGESTION_MAIL_LIMIT = 8;
const suggestionCache = new Map<string, SuggestionCacheEntry>();

let suggestionInitialSeen = false;
subscribeUserId(() => {
  if (!suggestionInitialSeen) {
    suggestionInitialSeen = true;
    return;
  }
  suggestionCache.clear();
});

function suggestionSignature(mails: MailForSuggestion[]): string {
  return mails
    .map((m) => `${m.id}|${m.from}|${m.subject}|${m.isRead ? 1 : 0}`)
    .join('\n');
}

function selectSuggestionMails(items: NormalizedMail[]): MailForSuggestion[] {
  return items
    .filter((m) => !m.isRead && needsReply(m.from))
    .slice(0, SUGGESTION_MAIL_LIMIT)
    .map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      receivedAt: m.receivedAt,
      isRead: m.isRead,
    }));
}

export function useChatSuggestions(): Result<string[]> {
  const { items, loading, error } = useMailItems();
  const [state, setState] = useState<Result<string[]>>({
    data: padSuggestions([]),
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!hasClaudeKey()) {
      setState({ data: padSuggestions([]), loading: false, error: null });
      return;
    }
    if (loading) {
      setState({ data: padSuggestions([]), loading: true, error: null });
      return;
    }
    if (error) {
      setState({ data: padSuggestions([]), loading: false, error });
      return;
    }

    const selected = selectSuggestionMails(items);
    if (selected.length === 0) {
      setState({ data: padSuggestions([]), loading: false, error: null });
      return;
    }

    const sig = suggestionSignature(selected);
    const cached = suggestionCache.get(sig);
    if (cached && cached.expiresAt > Date.now()) {
      setState({ data: cached.data, loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    setState((prev) => ({ data: prev.data, loading: true, error: null }));

    extractChatSuggestions(selected, controller.signal)
      .then((dynamic) => {
        if (controller.signal.aborted) return;
        const padded = padSuggestions(dynamic);
        suggestionCache.set(sig, {
          data: padded,
          expiresAt: Date.now() + SUGGESTION_TTL_MS,
        });
        setState({ data: padded, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (controller.signal.aborted || err.name === 'AbortError') return;
        if (__DEV__) console.warn('[hooks] chat suggestions failed:', err.message);
        setState({ data: padSuggestions([]), loading: false, error: err });
      });

    return () => {
      controller.abort();
    };
  }, [items, loading, error]);

  return { data: state.data.slice(0, CHAT_SUGGESTION_COUNT), loading: state.loading, error: state.error };
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const { data: profile } = useUser();
  const { user } = useAuth();
  const demo = isDemoUser(user);
  const demoIndexRef = useRef(0);
  const name = profile?.name ?? '';
  const userId = user?.id;

  // Reset messages + re-hydrate whenever the active user changes so chat
  // history never leaks across accounts.
  useEffect(() => {
    setMessages([]);
    setHydrated(false);
    demoIndexRef.current = 0;
    if (!userId) {
      setHydrated(true);
      return;
    }
    if (demo) {
      setHydrated(true);
      return;
    }
    let cancelled = false;
    hydratePrivacyCache()
      .then(() => {
        if (!getPrivacyFlag('local-only')) return null;
        return AsyncStorage.getItem(chatHistoryKey(userId));
      })
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const saved = JSON.parse(raw) as ChatMessage[];
          if (Array.isArray(saved)) setMessages(saved);
        } catch {}
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, demo]);

  useEffect(() => {
    if (!hydrated || !userId || demo) return;
    const key = chatHistoryKey(userId);
    if (!getPrivacyFlag('local-only')) {
      AsyncStorage.removeItem(key).catch(() => {});
      return;
    }
    const capped = messages.slice(-CHAT_HISTORY_LIMIT);
    AsyncStorage.setItem(key, JSON.stringify(capped)).catch(() => {});
  }, [messages, hydrated, userId]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        from: 'user',
        text: trimmed,
      };
      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      setTyping(true);

      if (demo) {
        const idx = demoIndexRef.current;
        demoIndexRef.current = idx + 1;
        const reply = DEMO_CHAT_SCRIPT[idx] ?? DEMO_CHAT_FALLBACK;
        setTimeout(() => {
          setMessages((cur) => [
            ...cur,
            { id: `a-${Date.now()}`, from: 'zolva', text: reply },
          ]);
          setTyping(false);
        }, 900);
        return;
      }

      if (userId) syncChatMessage(userId, userMsg);

      const metadata =
        getPrivacyFlag('training-opt-in') && userId ? { user_id: userId } : undefined;

      const runTurn = async (): Promise<string> => {
        const working: ClaudeMessage[] = toClaudeMessages(nextHistory);
        for (let round = 0; round < CHAT_TOOL_ROUND_CAP; round += 1) {
          const result = await completeRaw({
            system: buildChatSystemPrompt(name),
            messages: working,
            tools: CHAT_TOOLS,
            metadata,
          });
          if (result.toolUses.length === 0) {
            return result.text.trim();
          }
          working.push({ role: 'assistant', content: result.rawContent });
          const toolResults = await Promise.all(
            result.toolUses.map(async (t) => {
              const r = await runChatTool(t.name, t.input);
              return {
                type: 'tool_result' as const,
                tool_use_id: t.id,
                content: r.content,
                is_error: r.isError,
              };
            }),
          );
          working.push({ role: 'user', content: toolResults });
        }
        return 'Jeg nåede ikke frem til et svar. Prøv igen?';
      };

      runTurn()
        .then((answer) => {
          const assistantMsg: ChatMessage = {
            id: `a-${Date.now()}`,
            from: 'zolva',
            text: answer.length > 0 ? answer : CHAT_ERROR_TEXT,
          };
          setMessages((cur) => [...cur, assistantMsg]);
          if (userId) {
            syncChatMessage(userId, assistantMsg);
            runExtractor({
              trigger: 'chat_turn',
              userId,
              text: `Bruger: ${trimmed}\nZolva: ${assistantMsg.text}`,
              source: `chat:${assistantMsg.id}`,
            });
          }
        })
        .catch((err: Error) => {
          if (__DEV__ && getPrivacyFlag('anon-reports')) {
            console.warn('[useChat] Claude request failed:', err.message);
          }
          setMessages((cur) => [
            ...cur,
            { id: `e-${Date.now()}`, from: 'zolva', text: CHAT_ERROR_TEXT },
          ]);
        })
        .finally(() => setTyping(false));
    },
    [messages, name, userId, demo],
  );

  return { data: messages, typing, loading: false, error: null as Error | null, send };
}

export function usePendingFacts(): Result<Fact[]> & {
  accept: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
} {
  const { user } = useAuth();
  const userId = user?.id;
  const [state, setState] = useState<Result<Fact[]>>({ data: [], loading: false, error: null });
  const memoryEnabled = useMemoryEnabled();

  const refresh = useCallback(async () => {
    if (!userId || !memoryEnabled) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const rows = await listFacts(userId, 'pending');
      setState({ data: rows, loading: false, error: null });
    } catch (err) {
      setState({ data: [], loading: false, error: err as Error });
    }
  }, [userId, memoryEnabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  const accept = useCallback(async (id: string) => {
    await confirmFact(id);
    if (userId) invalidatePreamble(userId);
    void refresh();
  }, [refresh, userId]);

  const reject = useCallback(async (id: string) => {
    await rejectFact(id);
    if (userId) invalidatePreamble(userId);
    void refresh();
  }, [refresh, userId]);

  return { ...state, accept, reject };
}

function useMemoryEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => getPrivacyFlag('memory-enabled'));
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (!cancelled) setEnabled(getPrivacyFlag('memory-enabled'));
    };
    void hydratePrivacyCache().then(sync);
    privacyListeners.add(sync);
    return () => {
      cancelled = true;
      privacyListeners.delete(sync);
    };
  }, []);
  return enabled;
}

// ─── Memory consent helpers ────────────────────────────────────────────────

const memoryConsentKey = (uid: string) => `zolva.${uid}.memory.consent-shown-at`;

export async function shouldShowMemoryConsent(uid: string): Promise<boolean> {
  if (getPrivacyFlag('memory-enabled')) return false;
  try {
    const raw = await AsyncStorage.getItem(memoryConsentKey(uid));
    if (!raw) return true;
    const shownAt = parseInt(raw, 10);
    if (Number.isNaN(shownAt)) return true;
    const daysSince = (Date.now() - shownAt) / (1000 * 60 * 60 * 24);
    // Re-prompt once after 14 days if still off.
    return daysSince >= 14 && daysSince < 28;
  } catch {
    return true;
  }
}

export async function markMemoryConsentShown(uid: string): Promise<void> {
  try {
    await AsyncStorage.setItem(memoryConsentKey(uid), Date.now().toString());
  } catch {}
}

// ─── setPrivacyFlag ────────────────────────────────────────────────────────

export async function setPrivacyFlag(id: PrivacyFlagId, value: boolean): Promise<void> {
  ensurePrivacyUserSubscription();
  await hydratePrivacyCache();
  privacyCache = { ...privacyCache, [id]: value };
  const uid = privacyUid;
  if (uid) {
    try {
      await AsyncStorage.setItem(privacyTogglesKey(uid), JSON.stringify(privacyCache));
    } catch {}
  }
  notifyPrivacyChange();
}
