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
  listNotes,
  removeNote as storeRemoveNote,
  subscribeNotes,
} from './memory-store';
import {
  listAllReminders,
  addReminder,
  markReminderDone,
  deleteReminder,
  isPendingAndDueOrUpcoming,
  formatReminderForListTool,
} from './reminders';
import {
  eventEnd,
  eventStart,
  isAllDay as isGoogleAllDay,
  listEvents as listGoogleEvents,
  listEventsForCalendars as listGoogleEventsForCalendars,
  resolveGoogleEventColor,
} from './google-calendar';
import { listAllCalendars } from './calendar-providers';
import { useCalendarVisibility } from './calendar-visibility';
import {
  createDraft as gmailCreateDraft,
  getMessageBody as gmailGetMessageBody,
  initialsOf,
  listInboxMessages as listGmailMessages,
  getInboxCounts as getGmailInboxCounts,
  sendMail as gmailSendMail,
  sendReply as gmailSendReply,
} from './gmail';
import {
  archiveMessage as graphArchiveMessage,
  createDraft as graphCreateDraft,
  getMessageBody as graphGetMessageBody,
  listCalendarEvents as listGraphEvents,
  listCalendarEventsForCalendars as listGraphEventsForCalendars,
  listInboxMessages as listGraphMessages,
  getInboxCounts as getGraphInboxCounts,
  replyToMessage as graphReplyToMessage,
  sendMail as graphSendMail,
} from './microsoft-graph';
import { loadCredential } from './icloud-credentials';
import { useIntegrationFlags, isIntegrationEffectivelyEnabled, clearIntegrationFlags } from './integration-flags';
import { detectAdminConsentRequired } from './admin-consent';
import {
  listCalendarEventsAcrossProviders,
  listCalendarsAcrossProviders,
  listRecentMailAcrossProviders,
  readMailBody,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  searchDriveFilesTool,
  readDriveFile,
  searchOnedriveFilesTool,
  readOnedriveFile,
  type ChatCtx,
  type WriteEventInput,
} from './chat-tools';
import {
  buildCorrectionMessage,
  classifyClaim,
  GENERIC_CONFUSED_FALLBACK,
  CHAT_GUARD_DEBUG_TAG,
} from './chat-claim-guard';
import {
  getMessageBody as getIcloudMessageBody,
  listInbox as listIcloudMessages,
  getInboxCounts as getIcloudInboxCounts,
  subscribeToIcloudInboxCache,
  icloudSendMail,
  icloudAppendDraft,
  type IcloudErrorCode,
} from './icloud-mail';
import { recordSentMail, type RecordSentMailInput } from './sent-mails';
import { listEvents as listIcloudEvents } from './icloud-calendar';
import {
  readCalendarLabels,
  setCalendarLabel,
  subscribeCalendarLabelsChanged,
  type CalendarLabels,
  type CalendarLabelKey,
  type CalendarLabelTarget,
} from './calendar-labels';
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
import { writeSnapshotFromSources } from './widget-bridge';

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
  'Du er Zolva, en rolig dansk AI-assistent. Du kigger på din dag og ' +
  'peger blidt på mønstre der er værd at overveje. Svar altid på dansk. ' +
  'ADRESSERINGSKRAV: Skriv ALTID direkte med "du"/"dig"/"din". ' +
  'Omtal ALDRIG personen i 3. person ved navn eller pronomen — skriv ' +
  '"Du har 3 ulæste fra Lars", IKKE "Albert har 3 ulæste fra Lars" eller ' +
  '"Han har 3 ulæste". ' +
  'Skriv ALDRIG ordene "bruger", "brugeren", "brugerens" eller "brugere" — ' +
  'det er 2.-persons samtale, ikke en beskrivelse af en 3.-part. ' +
  `Returnér mellem 0 og ${OBSERVATION_MAX} observationer — kun dem der faktisk er relevante, ` +
  'sorteret med de vigtigste først. De første 2–3 vises på forsiden, resten i en oversigt. ' +
  'Hver observation skal være maks én sætning og undgå at gentage selvfølgeligheder. ' +
  '\n\n' +
  'KVALITETSKRAV — en observation skal pege på noget konkret du kan gøre:\n' +
  '1. SKRIV ALDRIG ren narration. "Din dag er fyldt med kvalitetstid: tre timer ' +
    'på sygehuset, så fem timer aftensmad — en god dag" er IKKE en observation, ' +
    'det er bare en oplæsning af kalenderen. Det HAR ingen værdi. Returnér NUL ' +
    'observationer hellere end at narrative dagen tilbage.\n' +
  '2. INGEN BLØDE OPMUNTRINGER uden handling. CTA\'er som "Nyd dagen", "Hav det ' +
    'godt", "Slap af", "God dag" er FORBUDT. Hvis CTA\'en ikke leder til en konkret ' +
    'mail-åbning eller en handling Zolva kan udføre med sine værktøjer, så ' +
    'observationen skal IKKE returneres.\n' +
  '3. EKTE OBSERVATIONER er ting som: "Du har 4 mails fra samme afsender — kig efter mønster", ' +
    '"Mødet kl. 14 har ingen agenda — bed om en", "Du har 3 timer mellem to møder ' +
    '— bloker tid til Q3-budget", "En invitation venter på svar siden i går", ' +
    '"To møder ligger 5 min fra hinanden — vil du flytte ét?". Decision/handling, ' +
    'ikke recap.\n' +
  '4. Hvis dagens kalender + indbakke IKKE indeholder noget der opfylder krav 3, ' +
    'returnér en TOM array []. Det er bedre end at producere fyldstof.';

const OBSERVATION_SCHEMA =
  '[{"id": string, "text": string, "cta": string, "mood": "calm" | "thinking" | "happy", "action": Action}]\n' +
  '- text: selve observationen på dansk (maks én sætning).\n' +
  '- cta: kort handlingsforslag på dansk (maks 4 ord), fx "Åbn mail", "Bloker tid" eller "Accepter".\n' +
  '- mood: "thinking" for noget der kræver beslutning, "calm" for rolig observation, "happy" for positivt.\n' +
  '- action: KRÆVET — hvad der skal ske når brugeren trykker på CTA\'en. Præcis to typer er tilladt:\n' +
  '  • {"kind":"openMail","mailId": string} — KUN når CTA\'en bare er at læse/se mailen passivt ("Læs mailen", "Se den"). Brug mail-id\'et vist i [id:…] i mail-listen.\n' +
  '  • {"kind":"prompt","prompt": string} — når CTA\'en er en HANDLING. "prompt" skal være en færdig 1. person-besked til Zolva på dansk der instruerer hvad der skal ske. Når brugeren trykker, sendes beskeden automatisk til chatten og Zolva udfører handlingen via sine værktøjer (læs mail, lav udkast, opret event, osv.).\n' +
  'REGLER FOR ACTION:\n' +
  '1. ACTION ER OBLIGATORISK. Hvis du ikke kan finde et openMail eller prompt der giver mening, så lad være med at returnere observationen overhovedet. Generisk "åbn chat uden grund" findes IKKE som handling.\n' +
  '2. EN PROMPT SKAL ALTID FORTÆLLE ZOLVA HVAD DER SKAL SKE. Aldrig en prompt som "Vis mig dagen" eller "Hjælp mig" — den skal være en specifik instruks med konkret kontekst (navn, emne, dato). Hvis brugeren ender i chatten skal de vide hvorfor.\n' +
  '3. MAIL → DRAFT som default: Hvis observationen handler om en mail der inviterer/spørger/kræver svar (en personlig henvendelse, en invitation, et spørgsmål, en deadline) — SKAL action være {"kind":"prompt","prompt":"Læs mailen [id:…] fra <afsender> om <emne> og lav et udkast til svar."}. CTA\'en bliver så fx "Svar med udkast" eller "Lav udkast". Når Zolva åbner skal udkastet være færdigt og klar til afsendelse.\n' +
  '4. MAIL → openMail KUN for passiv-læs: receipts, kvitteringer, sikkerhedsadvarsler, nyhedsbreve, automatiserede notifikationer hvor svar ikke giver mening. CTA "Læs den" / "Se mailen".\n' +
  '5. HANDLINGSVERBER kræver prompt: "Accepter", "Svar", "Bloker", "Gennemgå", "Ring", "Send", "Bekræft", "Slet", "Marker", "Arkiver", "Følg op", "Tilmeld" — alle disse SKAL være {"kind":"prompt",…} med en præcis instruks. Inkludér AFGØRENDE INFO (mailens emne, afsenderens navn, kalenderens titel, dato).\n' +
  '6. EKSEMPLER:\n' +
  '   - "Lars venter svar på frokost-invitation" → CTA "Lav udkast", prompt: "Læs mailen [id:abc] fra Lars om frokost og lav et udkast hvor jeg takker ja og foreslår torsdag kl. 12."\n' +
  '   - "Mødeindkaldelse fra Mette på torsdag" → CTA "Accepter", prompt: "Accepter mødeindkaldelsen fra Mette på torsdag kl. 14."\n' +
  '   - "Sikkerhedsadvarsel fra Google" → CTA "Læs den", action: {"kind":"openMail","mailId":"..."} (passiv læs).\n' +
  '   - "Tre møder uden agenda i morgen" → CTA "Bed om agendaer", prompt: "Send en kort mail til arrangørerne af de tre møder i morgen og bed om en agenda til hver."';

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
  // kind:'chat' is intentionally rejected — generic "open chat" CTAs ended
  // up wrapping pure-narration observations like "Nyd dagen → opens chat",
  // which felt pointless. If the model can't propose a concrete action
  // (openMail or prompt), the observation gets dropped upstream.
  return undefined;
}

// Normalize a string for dedup comparisons: lowercase, collapse whitespace,
// strip trailing punctuation. So "Du har 3 mails fra Lars." and "du har 3
// mails fra lars" both reduce to the same key.
function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?…]+$/u, '')
    .trim();
}

function sanitizeObservations(raw: unknown): Observation[] {
  if (!Array.isArray(raw)) return [];
  const moods: Observation['mood'][] = ['calm', 'thinking', 'happy'];
  // Two dedup keys: id (in case Claude reuses an id by accident, or generates
  // the placeholder "obs-1" twice) and normalized text (the more common bug —
  // the model paraphrases the same insight twice).
  const seenIds = new Set<string>();
  const seenTexts = new Set<string>();
  return raw.slice(0, OBSERVATION_MAX).flatMap((item, i): Observation[] => {
    if (!item || typeof item !== 'object') return [];
    const o = item as Partial<Observation> & { action?: unknown };
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) return [];
    const textKey = normalizeForDedup(text);
    if (seenTexts.has(textKey)) return [];
    const cta = typeof o.cta === 'string' ? o.cta.trim() : '';
    const mood = moods.includes(o.mood as Observation['mood'])
      ? (o.mood as Observation['mood'])
      : 'calm';
    const rawId = typeof o.id === 'string' && o.id ? o.id : `obs-${i + 1}`;
    if (seenIds.has(rawId)) return [];
    seenIds.add(rawId);
    seenTexts.add(textKey);
    const action = sanitizeAction(o.action);
    // Action is now required — drop observations that don't carry a real
    // openMail or prompt. Stops "Nyd dagen → opens chat" from leaking
    // through.
    if (!action) return [];
    return [{ id: rawId, text, cta, mood, action }];
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
  source: 'google' | 'microsoft' | 'icloud';
};

// Used by useMailItems / useCalendarItems / useHasProvider — credential
// presence determines whether to fan out an iCloud request and whether the
// account counts as "has any provider connected" for upstream gating.
export function useIcloudConnected(userId: string): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!userId) { setConnected(false); return; }
    void loadCredential(userId).then((c) => {
      if (!cancelled) setConnected(c.kind === 'valid');
    });
    return () => { cancelled = true; };
  }, [userId]);
  return connected;
}

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
// Mails the user has replied to. Distinct from dismissed: dismissed mails
// disappear into Archived, replied mails should drop out of "Venter på
// dig" but resurface under "Læst" — the user often wants to glance back
// at the original. We don't have gmail.modify or an iCloud \Seen-write
// path, so the only persistent server-side read state we get is from
// Outlook's auto-archive after reply. This local set bridges the gap.
//
// Persisted per-user via AsyncStorage so the "I already replied to this"
// state survives backgrounding and worker recycles — without persistence,
// the in-memory set was lost on cold-open and replied-to mails would
// bounce back into "Venter" the next time the inbox refreshed.
const repliedMailIds = new Set<string>();
const REPLIED_STORAGE_KEY = (uid: string) => `zolva.replied-mails.v1.${uid}`;
const dismissListeners = new Set<() => void>();

let repliedHydratedFor: string | null = null;
let repliedActiveUid: string | null = null;
async function hydrateRepliedFor(uid: string | null): Promise<void> {
  repliedActiveUid = uid;
  if (!uid) {
    repliedMailIds.clear();
    repliedHydratedFor = null;
    dismissListeners.forEach((l) => l());
    return;
  }
  if (repliedHydratedFor === uid) return;
  repliedMailIds.clear();
  try {
    const raw = await AsyncStorage.getItem(REPLIED_STORAGE_KEY(uid));
    if (raw) {
      const ids = JSON.parse(raw) as string[];
      if (Array.isArray(ids)) for (const id of ids) repliedMailIds.add(id);
    }
  } catch (err) {
    if (__DEV__) console.warn('[hooks] replied hydrate failed:', err);
  }
  repliedHydratedFor = uid;
  dismissListeners.forEach((l) => l());
}

async function persistReplied(): Promise<void> {
  if (!repliedActiveUid) return;
  try {
    await AsyncStorage.setItem(
      REPLIED_STORAGE_KEY(repliedActiveUid),
      JSON.stringify(Array.from(repliedMailIds)),
    );
  } catch (err) {
    if (__DEV__) console.warn('[hooks] replied persist failed:', err);
  }
}

// Clear dismissed (in-memory only) and re-hydrate replied (from storage)
// whenever the active user changes — including the initial subscribe so
// replied state is loaded on app open.
subscribeUserId((uid) => {
  if (dismissedMailIds.size > 0) {
    dismissedMailIds.clear();
    dismissListeners.forEach((l) => l());
  }
  void hydrateRepliedFor(uid ?? null);
});

function markMailDismissed(id: string): void {
  if (dismissedMailIds.has(id)) return;
  dismissedMailIds.add(id);
  dismissListeners.forEach((l) => l());
}

function markMailReplied(id: string): void {
  if (repliedMailIds.has(id)) return;
  repliedMailIds.add(id);
  dismissListeners.forEach((l) => l());
  void persistReplied();
}

// Public archive helper — used by the inbox-row swipe gesture. Microsoft
// is the only provider where we can archive server-side (graph-modify is
// part of the scope set we already request). Gmail and iCloud are local-
// only because we don't request gmail.modify and our IMAP proxy has no
// archive op. Failures are best-effort; the local dismissal still runs.
export async function archiveMailInline(id: string, provider: MailProvider): Promise<void> {
  try {
    if (provider === 'microsoft') await graphArchiveMessage(id);
  } catch (err) {
    if (__DEV__) console.warn('[hooks] archiveMailInline graph error:', err);
  }
  markMailDismissed(id);
}

// Public delete helper. For v1, this routes to the same local-dismiss
// path as archive — real server-side delete (graph DELETE for Outlook,
// IMAP STORE \Deleted + EXPUNGE for iCloud, gmail.modify for Gmail) is
// follow-up work. The visual differentiation (red "Slet" vs neutral
// "Arkivér") signals intent today; the backend action is the same.
export async function deleteMailInline(id: string, provider: MailProvider): Promise<void> {
  // Currently identical to archive. Kept as a separate export so the
  // call site stays semantically correct; when we wire real server-side
  // delete, only this body changes.
  await archiveMailInline(id, provider);
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

function useRepliedMailIds(): Set<string> {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    dismissListeners.add(listener);
    return () => { dismissListeners.delete(listener); };
  }, []);
  return repliedMailIds;
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

function useCalendarItems(
  rangeStartMs?: number,
  rangeEndMs?: number,
  // When true, fan out across every Google/Microsoft/iCloud calendar (not
  // just `primary`) and apply the user's visibility selection. Used by the
  // calendar tab. Default false keeps brief / chat / today on the legacy
  // primary-only path so this change doesn't expand their scope.
  respectVisibility = false,
): {
  items: NormalizedEvent[];
  loading: boolean;
  error: Error | null;
} {
  const { googleAccessToken, microsoftAccessToken, user } = useAuth();
  const userId = user?.id ?? '';
  const icloudConnected = useIcloudConnected(userId);
  const { visibility, hydrated: visibilityHydrated } = useCalendarVisibility(userId);
  const { isEnabled: isFlagEnabled, flags: integrationFlagsForCal } = useIntegrationFlags();
  const [state, setState] = useState<{
    items: NormalizedEvent[];
    loading: boolean;
    error: Error | null;
  }>({ items: [], loading: false, error: null });

  // Stable string snapshot of the visibility map so the effect only refires
  // when the actual hidden set changes (objects compare by reference).
  const visibilitySig = JSON.stringify(visibility);

  useEffect(() => {
    if (!user || (!googleAccessToken && !microsoftAccessToken && !icloudConnected)) {
      setState({ items: [], loading: false, error: null });
      return;
    }
    // Wait for visibility to hydrate when it's actually being used. Without
    // this, the first render fetches with an empty hidden set, then
    // re-fetches once AsyncStorage resolves — wasted round trip on cold open.
    if (respectVisibility && !visibilityHydrated) return;
    let cancelled = false;
    setState({ items: [], loading: true, error: null });
    const { start, end } =
      rangeStartMs != null && rangeEndMs != null
        ? { start: new Date(rangeStartMs), end: new Date(rangeEndMs) }
        : dayBounds(new Date());

    const tasks: Promise<NormalizedEvent[]>[] = [];
    const googleHidden = new Set(visibility.google ?? []);
    const microsoftHidden = new Set(visibility.microsoft ?? []);
    const icloudHidden = new Set(visibility.icloud ?? []);

    if (googleAccessToken && isFlagEnabled('google-calendar', true)) {
      tasks.push(
        (async () => {
          if (!respectVisibility) {
            // Legacy: primary only, no fan-out.
            const evts = await listGoogleEvents(start, end);
            return evts
              .map((e): NormalizedEvent | null => normalizeGoogleEvent(e))
              .filter((e): e is NormalizedEvent => e !== null);
          }
          // Fan out: list every readable calendar, drop the hidden ones,
          // events.list each in parallel. Listing is cheap (single round
          // trip); the per-calendar event fetches are what matters.
          const cals = await listAllCalendars({
            hasGoogle: true,
            hasMicrosoft: false,
            hasIcloud: false,
            userId,
          });
          const visibleIds = cals
            .filter((c) => c.provider === 'google' && !googleHidden.has(c.id))
            .map((c) => c.id);
          if (visibleIds.length === 0) return [];
          const evts = await listGoogleEventsForCalendars(visibleIds, start, end);
          return evts
            .map((e): NormalizedEvent | null => normalizeGoogleEvent(e))
            .filter((e): e is NormalizedEvent => e !== null);
        })(),
      );
    }
    if (microsoftAccessToken && isFlagEnabled('outlook-calendar', true)) {
      tasks.push(
        (async () => {
          if (!respectVisibility) {
            const evts = await listGraphEvents(start, end);
            return evts.map(normalizeGraphEvent);
          }
          // Microsoft's /me/calendarView is already cross-calendar — we just
          // tell the helper which IDs are visible and it filters server-
          // returned results. No extra round trip vs. the legacy path.
          const cals = await listAllCalendars({
            hasGoogle: false,
            hasMicrosoft: true,
            hasIcloud: false,
            userId,
          });
          const visibleIds = cals
            .filter((c) => c.provider === 'microsoft' && !microsoftHidden.has(c.id))
            .map((c) => c.id);
          if (visibleIds.length === 0) return [];
          const evts = await listGraphEventsForCalendars(start, end, visibleIds);
          return evts.map(normalizeGraphEvent);
        })(),
      );
    }
    if (icloudConnected && userId && isFlagEnabled('icloud', true)) {
      tasks.push(
        listIcloudEvents(userId, start, end).then((r) => {
          if (!r.ok) throw new Error(`icloud:${r.error}`);
          // iCloud's listEvents already fans across all CalDAV calendars; we
          // just drop events whose source calendar URL is in the hidden set.
          const items = r.data
            .filter((e) => !respectVisibility || !icloudHidden.has(e.calendarUrl))
            .map((e): NormalizedEvent => ({
              id: `icloud:${e.uid}`,
              title: e.title,
              location: e.location,
              start: e.start,
              end: e.end,
              allDay: e.allDay,
              description: e.description,
              color: e.calendarColor,
              source: 'icloud',
            }));
          return items;
        }),
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

    // Promise.allSettled: one provider's failure doesn't blank the others.
    // We surface an error only if EVERY provider failed; otherwise we render
    // the partial results and log the failures so the user still sees what
    // worked.
    Promise.allSettled(tasks)
      .then((results) => {
        clearTimeout(timeoutId);
        if (cancelled) return;
        const fulfilled = results.flatMap((r) =>
          r.status === 'fulfilled' ? r.value : [],
        );
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (__DEV__) {
          for (const r of rejected) {
            console.warn('[hooks] calendar provider failed:', (r.reason as Error)?.message ?? r.reason);
          }
        }
        const allFailed = rejected.length === results.length && results.length > 0;
        const merged = fulfilled
          .sort((a, b) => a.start.getTime() - b.start.getTime())
          .map((e, i) => ({ ...e, color: RIBBON_PALETTE[i % RIBBON_PALETTE.length] }));
        setState({
          items: merged,
          loading: false,
          error: allFailed
            ? new Error('Kalender-forespørgslen fejlede. Prøv igen.')
            : null,
        });
        // Push today's events into the widget snapshot. We narrow to today
        // (local) here so the bridge layer doesn't have to.
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(todayStart);
        todayEnd.setDate(todayEnd.getDate() + 1);
        const todayEvents = fulfilled
          .filter((e) => e.start >= todayStart && e.start < todayEnd)
          .map((e) => ({ id: e.id, start: e.start, end: e.end, title: e.title }));
        void writeSnapshotFromSources({ events: todayEvents });
      });

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [
    googleAccessToken,
    microsoftAccessToken,
    user,
    rangeStartMs,
    rangeEndMs,
    icloudConnected,
    userId,
    respectVisibility,
    visibilityHydrated,
    visibilitySig,
    // Refetch when the user toggles a calendar integration on/off so the
    // ribbon/day view updates without needing a navigation roundtrip.
    integrationFlagsForCal['google-calendar'],
    integrationFlagsForCal['outlook-calendar'],
    integrationFlagsForCal['icloud'],
  ]);

  return state;
}

// Normalize a Google Calendar event into the cross-provider shape used by
// the calendar UI. Returns null when the event is missing both start and
// end timestamps (recurring-master entries surface this way occasionally).
function normalizeGoogleEvent(
  e: import('./google-calendar').GoogleCalendarEvent,
): NormalizedEvent | null {
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
}

function normalizeGraphEvent(e: import('./microsoft-graph').GraphCalendarEvent): NormalizedEvent {
  return {
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
  };
}

// Per-provider failure surfaced to the UI when one provider errored but at
// least one other succeeded — without this, `Promise.allSettled` swallowed
// e.g. an iCloud `protocol`/`timeout` and the user saw Gmail mails with no
// hint that Apple-mails were missing.
export type MailProviderError = {
  provider: 'google' | 'microsoft' | 'icloud';
  // For iCloud: the `IcloudErrorCode` from icloud-mail. For others: 'failed'.
  // Auth-failed iCloud errors still appear here, but InboxScreen suppresses
  // the soft banner for them since the credential-invalid banner covers that.
  code: string;
};

// Per-provider mail fetch ceiling. Higher than the visible "Venter" slice so
// the downstream `!isRead` filter has headroom — active Outlook/Gmail users
// often have many already-read items at the top of their inbox after reading
// on another client, and a small window left them with zero unreads to show.
const MAIL_FETCH_PER_PROVIDER = 50;

// Module-level refresh signal: pull-to-refresh on the inbox needs every
// consumer of useMailItems to refetch in lockstep (waiting + cleared lists
// share a backing fetch but each owns its own effect/state). Bumping the tick
// changes a useEffect dep across all consumers, which retriggers the fetch.
let mailRefreshTick = 0;
const mailRefreshListeners = new Set<(tick: number) => void>();
export function refreshMailNow(): void {
  mailRefreshTick += 1;
  mailRefreshListeners.forEach((l) => l(mailRefreshTick));
}

function useMailItems(): {
  items: NormalizedMail[];
  loading: boolean;
  error: Error | null;
  providerErrors: MailProviderError[];
} {
  const { googleAccessToken, microsoftAccessToken, user } = useAuth();
  const userId = user?.id ?? '';
  const icloudConnected = useIcloudConnected(userId);
  const { isEnabled: isFlagEnabled, flags: integrationFlagsForMail } = useIntegrationFlags();
  const [state, setState] = useState<{
    items: NormalizedMail[];
    loading: boolean;
    error: Error | null;
    providerErrors: MailProviderError[];
  }>({ items: [], loading: false, error: null, providerErrors: [] });
  const [refreshTick, setRefreshTick] = useState(mailRefreshTick);
  useEffect(() => {
    mailRefreshListeners.add(setRefreshTick);
    return () => {
      mailRefreshListeners.delete(setRefreshTick);
    };
  }, []);

  // SWR fold-in: when the iCloud cache lands fresh data behind our back
  // (background revalidation), bump the same refresh tick so this hook
  // re-runs and re-renders the inbox with the new data. Subscribers fire
  // only when the message-list signature actually changed, so we don't
  // re-render on no-op revalidations.
  useEffect(() => {
    const unsub = subscribeToIcloudInboxCache(() => {
      // Reuse the global tick so existing observers (this hook + any
      // others listening to mail refresh) all wake up together.
      mailRefreshTick += 1;
      mailRefreshListeners.forEach((l) => l(mailRefreshTick));
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user || (!googleAccessToken && !microsoftAccessToken && !icloudConnected)) {
      setState({ items: [], loading: false, error: null, providerErrors: [] });
      return;
    }
    let cancelled = false;
    setState({ items: [], loading: true, error: null, providerErrors: [] });

    type Task = {
      provider: 'google' | 'microsoft' | 'icloud';
      run: () => Promise<NormalizedMail[]>;
    };
    const tasks: Task[] = [];
    if (googleAccessToken && isFlagEnabled('gmail', true)) {
      tasks.push({
        provider: 'google',
        run: () =>
          listGmailMessages(MAIL_FETCH_PER_PROVIDER).then((msgs) =>
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
      });
    }
    if (microsoftAccessToken && isFlagEnabled('outlook-mail', true)) {
      tasks.push({
        provider: 'microsoft',
        run: () =>
          listGraphMessages(MAIL_FETCH_PER_PROVIDER).then((msgs) =>
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
      });
    }
    if (icloudConnected && userId && isFlagEnabled('icloud', true)) {
      tasks.push({
        provider: 'icloud',
        run: () =>
          listIcloudMessages(userId, MAIL_FETCH_PER_PROVIDER).then((r) => {
            if (!r.ok) {
              // markInvalid was already called inside icloud-mail.ts on auth-failed.
              throw new Error(`icloud:${r.error}`);
            }
            return r.data.map((m) => ({
              id: `icloud:${m.uid}`,
              provider: 'icloud' as const,
              from: m.from,
              subject: m.subject,
              receivedAt: m.date,
              isRead: !m.unread,
              preview: m.preview,
            }));
          }),
      });
    }

    // Promise.allSettled: one provider's failure shouldn't blank Gmail/Outlook
    // mails when iCloud is flaky. Error state surfaces only when all providers
    // failed; per-provider errors are reported separately so the UI can show
    // a soft banner for "iCloud failed but Gmail loaded" instead of silently
    // dropping the missing provider.
    Promise.allSettled(tasks.map((t) => t.run()))
      .then((results) => {
        if (cancelled) return;
        const fulfilled: NormalizedMail[] = [];
        const providerErrors: MailProviderError[] = [];
        results.forEach((r, i) => {
          const provider = tasks[i].provider;
          if (r.status === 'fulfilled') {
            fulfilled.push(...r.value);
            return;
          }
          const reason = r.reason as Error | undefined;
          const msg = reason?.message ?? String(r.reason);
          if (__DEV__) {
            console.warn(`[hooks] mail provider ${provider} failed:`, msg);
          }
          const code = msg.startsWith('icloud:') ? msg.slice('icloud:'.length) : 'failed';
          providerErrors.push({ provider, code });
        });
        const allFailed = providerErrors.length === results.length && results.length > 0;
        const merged = fulfilled.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
        setState({
          items: merged,
          loading: false,
          error: allFailed
            ? new Error('Kunne ikke hente indbakke. Noget gik galt. Prøv igen.')
            : null,
          providerErrors,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    googleAccessToken,
    microsoftAccessToken,
    user,
    icloudConnected,
    userId,
    refreshTick,
    integrationFlagsForMail['gmail'],
    integrationFlagsForMail['outlook-mail'],
    integrationFlagsForMail['icloud'],
  ]);

  return state;
}

// Per-provider, server-reported INBOX counts. The displayed total/unread
// numbers come from this hook so they don't drift with the per-fetch
// limit window in useMailItems. The list-of-mails still flows through
// useMailItems (capped at MAIL_FETCH_PER_PROVIDER per provider) — this
// hook only feeds the headline counts.
//
// On per-provider failure the previous successful count for that provider
// is retained so transient flakes (e.g. an iCloud cold-start timeout)
// don't visibly drop the displayed total to zero. A subsequent refetch
// picks up real numbers again.
type InboxCounts = { total: number; unread: number };
type ProviderInboxCounts = {
  google: InboxCounts | null;
  microsoft: InboxCounts | null;
  icloud: InboxCounts | null;
};

export function useInboxCounts(): {
  total: number;
  unread: number;
  perProvider: ProviderInboxCounts;
  loading: boolean;
} {
  const { user, googleAccessToken, microsoftAccessToken } = useAuth();
  const userId = user?.id ?? '';
  const icloudConnected = useIcloudConnected(userId);
  const { isEnabled: isFlagEnabled, flags: integrationFlagsForCounts } = useIntegrationFlags();
  const demo = isDemoUser(user);
  const [perProvider, setPerProvider] = useState<ProviderInboxCounts>({
    google: null,
    microsoft: null,
    icloud: null,
  });
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(mailRefreshTick);
  useEffect(() => {
    mailRefreshListeners.add(setRefreshTick);
    return () => {
      mailRefreshListeners.delete(setRefreshTick);
    };
  }, []);

  useEffect(() => {
    if (demo) return;
    if (!user) {
      setPerProvider({ google: null, microsoft: null, icloud: null });
      return;
    }
    let cancelled = false;
    const wantGoogle = !!googleAccessToken && isFlagEnabled('gmail', true);
    const wantMicrosoft = !!microsoftAccessToken && isFlagEnabled('outlook-mail', true);
    const wantIcloud = icloudConnected && !!userId && isFlagEnabled('icloud', true);
    if (!wantGoogle && !wantMicrosoft && !wantIcloud) {
      setPerProvider({ google: null, microsoft: null, icloud: null });
      return;
    }

    setLoading(true);
    void Promise.allSettled([
      wantGoogle ? getGmailInboxCounts() : Promise.resolve(null),
      wantMicrosoft ? getGraphInboxCounts() : Promise.resolve(null),
      wantIcloud
        ? getIcloudInboxCounts(userId).then((r) => (r.ok ? r.data : null))
        : Promise.resolve(null),
    ]).then((results) => {
      if (cancelled) return;
      setPerProvider((prev) => ({
        // Retain the previous count on failure (or when the provider isn't
        // connected). Replace with the fresh value only when the call
        // succeeded — null means "no data yet"; failed calls keep the
        // last-known good number visible.
        google:
          results[0].status === 'fulfilled' && results[0].value
            ? results[0].value
            : wantGoogle
              ? prev.google
              : null,
        microsoft:
          results[1].status === 'fulfilled' && results[1].value
            ? results[1].value
            : wantMicrosoft
              ? prev.microsoft
              : null,
        icloud:
          results[2].status === 'fulfilled' && results[2].value
            ? results[2].value
            : wantIcloud
              ? prev.icloud
              : null,
      }));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    demo,
    user,
    googleAccessToken,
    microsoftAccessToken,
    icloudConnected,
    userId,
    refreshTick,
    integrationFlagsForCounts['gmail'],
    integrationFlagsForCounts['outlook-mail'],
    integrationFlagsForCounts['icloud'],
  ]);

  // In demo mode the inbox is fully synthesized client-side, so the count
  // is exactly the demo data length. No async fetch involved.
  if (demo) {
    const w = demoInboxWaiting().length;
    const a = demoInboxArchived().length;
    return {
      total: w + a,
      unread: w,
      perProvider: { google: { total: w + a, unread: w }, microsoft: null, icloud: null },
      loading: false,
    };
  }

  const total =
    (perProvider.google?.total ?? 0) +
    (perProvider.microsoft?.total ?? 0) +
    (perProvider.icloud?.total ?? 0);
  const unread =
    (perProvider.google?.unread ?? 0) +
    (perProvider.microsoft?.unread ?? 0) +
    (perProvider.icloud?.unread ?? 0);
  return { total, unread, perProvider, loading };
}

export function useHasProvider(): boolean {
  const { googleAccessToken, microsoftAccessToken, user } = useAuth();
  const icloudConnected = useIcloudConnected(user?.id ?? '');
  if (isDemoUser(user)) return true;
  return !!(googleAccessToken || microsoftAccessToken || icloudConnected);
}

function shortTime(then: Date, now: Date): string {
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();
  if (sameDay) return clockOf(then);
  // Compare CALENDAR days, not 24-hour chunks. Yesterday at 14:00 is ~22h
  // ago and would otherwise floor to 0d, even though it's a different day.
  const thenMidnight = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((nowMidnight - thenMidnight) / 86400000);
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
// Per-user storage keys. The legacy non-scoped key is wiped on first hydrate
// after this commit so account A's drafts don't sit in plaintext on disk
// after sign-out — even though the in-memory cache key (mail-id::tone::name)
// already prevents cross-account *serving*, the on-disk persistence was a
// privacy hole. Pattern matches the per-user chatHistoryKey() below.
const LEGACY_DRAFT_STORAGE_KEY = 'zolva.mail.drafts';
const draftStorageKey = (uid: string) => `zolva.mail.drafts.${uid}`;
const draftCache = new Map<string, DraftCacheEntry>();
let draftCacheUid: string | null = null;
let draftCacheHydrated = false;
let draftCacheHydrationPromise: Promise<void> | null = null;
let draftCacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
let legacyDraftKeyWiped = false;

async function hydrateDraftCache(uid: string): Promise<void> {
  if (draftCacheHydrated && draftCacheUid === uid) return;
  // User changed (sign-out → sign-in as someone else). Throw away the prior
  // user's in-memory entries, cancel any inflight persist, and re-hydrate
  // from this user's per-user key.
  if (draftCacheUid !== uid) {
    draftCache.clear();
    if (draftCacheWriteTimer) {
      clearTimeout(draftCacheWriteTimer);
      draftCacheWriteTimer = null;
    }
    draftCacheHydrated = false;
    draftCacheHydrationPromise = null;
    draftCacheUid = uid;
  }
  if (draftCacheHydrationPromise) return draftCacheHydrationPromise;
  draftCacheHydrationPromise = (async () => {
    try {
      // One-time legacy wipe — no-op after the first run on each device.
      if (!legacyDraftKeyWiped) {
        legacyDraftKeyWiped = true;
        AsyncStorage.removeItem(LEGACY_DRAFT_STORAGE_KEY).catch(() => {});
      }
      const raw = await AsyncStorage.getItem(draftStorageKey(uid));
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
    const uid = draftCacheUid;
    // No active user → no key to write to. Drop the snapshot rather than
    // recreating the legacy global key. Re-hydrate on next sign-in will
    // pull whatever the user already had on disk.
    if (!uid) return;
    const snapshot: Record<string, DraftCacheEntry> = {};
    draftCache.forEach((v, k) => {
      snapshot[k] = v;
    });
    AsyncStorage.setItem(draftStorageKey(uid), JSON.stringify(snapshot)).catch((err) => {
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
//
// Kept intentionally narrow — earlier versions also blocked info@/support@/
// notifications@/alerts@/updates@, but those prefixes catch too many legit
// human senders (account managers writing from info@, vendor support agents
// replying from support@). The classifier handles those cases now.
const NO_REPLY_PATTERN =
  /noreply|no-reply|no_reply|donotreply|do-not-reply|mailer-daemon|bounce@|newsletter|marketing|no-reply@accounts\.google\.com|(no-reply|receipts|notifications|invoice\+.*)@stripe\.com/i;

function needsReply(from: string): boolean {
  return !NO_REPLY_PATTERN.test(from);
}

// Body-level second-pass filter. Catches mails whose primary call-to-action
// is "click a link to do X on a website" — verification, activation, password
// reset, marketing, view-in-browser. These slip through the From regex when
// the sender domain looks human (e.g. Zoom invites from a person's email).
// Keeping this list short and high-signal — anything ambiguous falls through
// to the LLM classifier.
const NON_REPLY_BODY_PATTERNS: ReadonlyArray<RegExp> = [
  // English
  /view (this|the|your) (email|message) (in (your )?browser|online)/i,
  /click (here )?to (verify|activate|confirm|reset|view|unsubscribe|manage|review)/i,
  /unsubscribe|manage (your )?(subscription|preferences|notifications?)/i,
  /this (email|message) was sent (to you )?because/i,
  /you('re| are) receiving this (email|message|notification)/i,
  /please do not reply (to this )?(email|message)/i,
  /this is an automated (email|message|notification)/i,
  /verify your (email|account|address)/i,
  /(activate|confirm|complete) your (account|registration|signup)/i,
  /reset your password|password reset request/i,
  // Danish
  /se (mailen|denne mail|beskeden) (i (din )?browser|online)/i,
  /klik her for at (bekræfte|aktivere|nulstille|se|afmelde|administrere)/i,
  /afmeld (dig )?(nyhedsbrev|notifikationer)/i,
  /du modtager denne (mail|besked|notifikation) fordi/i,
  /svar ikke på (denne|denne) (mail|besked)/i,
  /dette er en automatisk (mail|besked|notifikation)/i,
  /bekræft (din )?(email|konto|adresse)/i,
  /(aktivér|bekræft|fuldfør) din (konto|registrering|tilmelding)/i,
  /nulstil (din )?adgangskode/i,
];

function looksLikeNonReplyContent(preview: string | null | undefined): boolean {
  if (!preview) return false;
  const window = preview.slice(0, 800);
  return NON_REPLY_BODY_PATTERNS.some((re) => re.test(window));
}

// Subject-line urgency keywords. Used by the inbox sort to bump mails to
// tier 0 even before the AI-draft classifier reaches them. Word-boundary
// matched so "vigtigste" (superlative form) doesn't fire on a partial
// match against "vigtigt".
const URGENCY_SUBJECT_PATTERN = new RegExp(
  '\\b(' +
    [
      // Danish
      'haster', 'akut', 'vigtigt', 'frist', 'sidste chance',
      // English
      'urgent', 'asap', 'important', 'deadline', 'reminder',
    ].join('|') +
  ')\\b',
  'i',
);

function hasUrgentSubject(subject: string | null | undefined): boolean {
  if (!subject) return false;
  return URGENCY_SUBJECT_PATTERN.test(subject);
}

// Marketing / newsletter heuristic — broader than the strict NO_REPLY_PATTERN
// (which only catches mailer-daemon-style senders) and broader than
// looksLikeNonReplyContent (which only matches verification/unsubscribe
// boilerplate in the preview). This catches the middle ground: mails from
// human-looking sender addresses that are still bulk marketing — startup
// digests, retailer promos, "weekly roundup" newsletters.
//
// We keep these patterns in their own function so a false positive only
// demotes a mail one tier (1 → 2) without changing the strict no-reply
// classification. If the existing reply classifier later disagrees the
// classifier wins (its verdict is checked first in urgencyTier).

const MARKETING_SENDER_PATTERN = new RegExp(
  // Senders that are almost always automated mass mail. Kept conservative —
  // the legit-human comment on NO_REPLY_PATTERN still applies (info@/
  // support@/hello@ aren't here for the same reason). Anchored on '@' so
  // we don't fire on personal addresses that happen to contain "news".
  '(^|<|\\s|")(' +
    [
      'news(letter)?',
      'nyt',
      'nyhedsbrev',
      'digest',
      'broadcast',
      'announcements?',
      'updates?',
      'alerts?',
      'promo(tions?)?',
      'offers?',
      'deals?',
      'sale',
      'shop',
      'mailing',
      'campaigns?',
      'kampagne',
      'tilbud',
    ].join('|') +
  ')@',
  'i',
);

const MARKETING_SUBJECT_PATTERN = new RegExp(
  '(' +
    [
      // Discount / promo phrases
      '\\d+\\s*%\\s*(off|rabat)',
      '\\bsave\\s+\\d+',
      '\\bspar\\s+\\d+',
      '\\bup to\\s+\\d+\\s*%',
      '\\bop til\\s+\\d+\\s*%',
      '\\bfree shipping\\b',
      '\\bfri fragt\\b',
      '\\btoday only\\b',
      '\\bkun i dag\\b',
      // Newsletter framings
      '\\b(weekly|monthly|daily) (digest|roundup|update)\\b',
      '\\b(ugens|månedens|dagens) (nyt|nyheder|udvalg)\\b',
      '\\b(this week|this month) in\\b',
      '\\bnewsletter\\b',
      '\\bnyhedsbrev\\b',
      // Listicle / clickbait shapes common in marketing subjects
      '^top\\s+\\d+',
      '^the\\s+\\d+\\s+(best|top|things|ways)',
      '^\\d+\\s+(ways|måder|tips|grunde)\\s+to',
    ].join('|') +
  ')',
  'i',
);

const MARKETING_BODY_PATTERN = new RegExp(
  '(' +
    [
      // Promo CTAs
      'shop now', 'køb nu', 'buy now',
      'save \\d+%', 'spar \\d+%',
      '\\d+%\\s*off', '\\d+%\\s*rabat',
      'exclusive offer', 'eksklusivt tilbud',
      'limited time', 'tidsbegrænset',
      'today only', 'kun i dag',
      // Newsletter framings
      'in this (issue|week|edition)', 'i (denne uge|denne udgave)',
      'here\'?s what\'?s new', 'her er hvad der er nyt',
      // Aggressive unsubscribe phrasings the existing pattern misses
      'manage (your )?email preferences', 'administrer (dine )?(email|mail)-?(indstillinger|præferencer)',
      'click here to unsubscribe', 'klik her for at afmelde',
      'opt out of (these|future) (emails|messages|notifications?)',
      'frameld dig (vores )?(nyhedsbrev|emails)',
    ].join('|') +
  ')',
  'i',
);

function looksLikeMarketing(m: NormalizedMail): boolean {
  if (MARKETING_SENDER_PATTERN.test(m.from)) return true;
  if (m.subject && MARKETING_SUBJECT_PATTERN.test(m.subject)) return true;
  if (m.preview && MARKETING_BODY_PATTERN.test(m.preview.slice(0, 1500))) return true;
  return false;
}

// Combined tier for a single mail. Reads the verdict cache (free) plus
// the from/preview/subject heuristics (also free). Intentionally pure of
// React state so the sort recomputes deterministically on every render.
function urgencyTier(m: NormalizedMail): 0 | 1 | 2 | 3 {
  const verdict = getVerdictFromCache(m.id);
  // Top tier: confirmed by classifier OR subject screams urgent.
  if (verdict === true) return 0;
  if (hasUrgentSubject(m.subject)) return 0;
  // Bottom tier: hard no-reply sender — mail will never deserve a reply.
  if (!needsReply(m.from)) return 3;
  // Middle-low: classifier or body markers say "no reply", or our broader
  // marketing heuristic catches a newsletter-shaped mail.
  if (verdict === false) return 2;
  if (looksLikeNonReplyContent(m.preview)) return 2;
  if (looksLikeMarketing(m)) return 2;
  // Default: human-looking, not yet classified.
  return 1;
}

// Reply-verdict cache. Classifier output is deterministic for a given mail,
// so we keep a persisted 24h cache to avoid re-paying on refresh / cold start.
// Separate from draftCache because verdicts are tone-agnostic (one entry per
// mail id) while drafts depend on the user's configured tone.
type VerdictCacheEntry = { needsReply: boolean; expiresAt: number };
const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
// Per-user storage. See draft cache above for rationale — same shape.
const LEGACY_VERDICT_STORAGE_KEY = 'zolva.mail.reply-verdicts';
const verdictStorageKey = (uid: string) => `zolva.mail.reply-verdicts.${uid}`;
const verdictCache = new Map<string, VerdictCacheEntry>();
let verdictCacheUid: string | null = null;
let verdictCacheHydrated = false;
let verdictCacheHydrationPromise: Promise<void> | null = null;
let verdictCacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
let legacyVerdictKeyWiped = false;

async function hydrateVerdictCache(uid: string): Promise<void> {
  if (verdictCacheHydrated && verdictCacheUid === uid) return;
  if (verdictCacheUid !== uid) {
    verdictCache.clear();
    if (verdictCacheWriteTimer) {
      clearTimeout(verdictCacheWriteTimer);
      verdictCacheWriteTimer = null;
    }
    verdictCacheHydrated = false;
    verdictCacheHydrationPromise = null;
    verdictCacheUid = uid;
  }
  if (verdictCacheHydrationPromise) return verdictCacheHydrationPromise;
  verdictCacheHydrationPromise = (async () => {
    try {
      if (!legacyVerdictKeyWiped) {
        legacyVerdictKeyWiped = true;
        AsyncStorage.removeItem(LEGACY_VERDICT_STORAGE_KEY).catch(() => {});
      }
      const raw = await AsyncStorage.getItem(verdictStorageKey(uid));
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
    const uid = verdictCacheUid;
    if (!uid) return;
    const snapshot: Record<string, VerdictCacheEntry> = {};
    verdictCache.forEach((v, k) => {
      snapshot[k] = v;
    });
    AsyncStorage.setItem(verdictStorageKey(uid), JSON.stringify(snapshot)).catch((err) => {
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

// Sign-out cleanup. clearUserScopedAsyncStorage in auth.ts already removes
// these keys via its `endsWith('.<uid>')` heuristic on sign-out, but we
// listen here too so we can:
//   1. Cancel pending persist timers — without this, a setTimeout from a
//      setDraftInCache call moments before sign-out can fire after the
//      disk wipe and re-create the deleted file.
//   2. Wipe the in-memory Map so old drafts don't sit in the JS heap while
//      signed out.
//   3. Remove the two specific keys explicitly rather than depending on
//      the heuristic — defends against future renames of the AsyncStorage
//      key shape.
let mailCacheLastSeenUid: string | null | undefined;
subscribeUserId((uid) => {
  // First fire is the initial subscribe — skip; we hydrate lazily inside
  // useInboxWaiting and the in-memory caches start empty anyway.
  if (mailCacheLastSeenUid === undefined) {
    mailCacheLastSeenUid = uid;
    return;
  }
  if (mailCacheLastSeenUid === uid) return;

  const prevUid = mailCacheLastSeenUid;
  mailCacheLastSeenUid = uid;

  if (draftCacheWriteTimer) {
    clearTimeout(draftCacheWriteTimer);
    draftCacheWriteTimer = null;
  }
  if (verdictCacheWriteTimer) {
    clearTimeout(verdictCacheWriteTimer);
    verdictCacheWriteTimer = null;
  }
  draftCache.clear();
  verdictCache.clear();
  draftCacheHydrated = false;
  verdictCacheHydrated = false;
  draftCacheHydrationPromise = null;
  verdictCacheHydrationPromise = null;
  draftCacheUid = null;
  verdictCacheUid = null;

  if (prevUid) {
    AsyncStorage.removeItem(draftStorageKey(prevUid)).catch(() => {});
    AsyncStorage.removeItem(verdictStorageKey(prevUid)).catch(() => {});
  }
});

const CLASSIFIER_SYSTEM_PROMPT =
  'You decide whether an incoming email warrants a human reply from the recipient. ' +
  'Answer YES only for messages from a real person that ask a question, make a request, ' +
  'invite the recipient, follow up on a conversation, or otherwise need a response to ' +
  'continue. Answer NO for: receipts, shipping or booking confirmations, login alerts, ' +
  'OTP and verification codes, marketing and newsletters, automated status notifications, ' +
  'calendar invites, subscription renewals, delivery updates, and anything that says ' +
  '"do not reply" in the body. ' +
  // Strengthened guidance — drafts on these were leaking past the From-regex.
  'Also answer NO for any email whose primary action is to click a link or visit a ' +
  'website (verify your account, activate, reset password, view receipt, view in ' +
  'browser, manage subscription, complete signup, review activity) — replying to such ' +
  'mails accomplishes nothing because the sender does not read replies. ' +
  'When genuinely uncertain, answer YES — missing a real ' +
  'reply is worse than declining one.';

// Classifies one mail. Fails open: any error (network, rate limit, parse)
// returns true so the downstream draft call still runs, matching legacy
// over-drafting behavior on transient failures.
async function classifyNeedsReply(
  mail: NormalizedMail,
  signal: AbortSignal,
): Promise<boolean> {
  // 800 chars: many marketing mails put boilerplate above the call-to-action,
  // so 400 was sometimes leaving the "click here to verify" line out of scope.
  const preview = (mail.preview ?? '').slice(0, 800);
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

function draftSystemPrompt(tone: string, userName: string | null): string {
  const toneLine = TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS.Venlig;
  const whoLine = userName
    ? `Du skriver et svar på vegne af ${userName} (én person, ikke et team eller en virksomhed).`
    : 'Du skriver et svar på vegne af brugeren (én person, ikke et team eller en virksomhed).';
  return (
    `${whoLine} ${toneLine} Skriv altid på dansk. ` +
    // The pronoun rule: default hard to "jeg". Drafts kept slipping into "vi"
    // when the incoming mail was business-styled (e.g. an invoice question),
    // which reads wrong from a personal assistant. Override only when the
    // user is unambiguously representing a company in the conversation.
    "Skriv ALTID i 'jeg' form — brug 'jeg', 'mig', 'min'. Brug ALDRIG 'vi', 'os' " +
    "eller 'vores' medmindre det er soleklart at brugeren repræsenterer en " +
    'virksomhed/team i denne specifikke samtale (fx en kunde der spørger ind ' +
    "til virksomhedens politik). Ved tvivl: brug 'jeg'. " +
    'Lov aldrig konkrete datoer, tidspunkter, priser eller oplysninger du ikke kender. ' +
    'Undgå hilsen og underskrift — skriv kun selve svaret. Returnér kun udkastet, uden anførselstegn eller kommentarer.'
  );
}

const AUTONOMY_TARGETS: Record<string, number> = {
  'Spørg altid': 0,
  'Lav udkast': 6,
  'Handl selv': 10,
};

// Drafts are user-facing Danish copy — Sonnet 4.6 is meaningfully better at
// tone calibration and Danish phrasing than Haiku. Cost delta is small since
// drafts are ~160 tokens each and only a handful run per inbox refresh.
const DRAFT_MODEL = 'claude-sonnet-4-6';

async function generateDraft(
  mail: NormalizedMail,
  tone: string,
  userName: string | null,
  signal: AbortSignal,
): Promise<string> {
  // Include the preview body so Claude can actually read what's being asked,
  // not just the subject line. 800 chars matches the classifier window — the
  // body context is what lets the pronoun heuristic land correctly (a mail
  // that reads "jeg har et spørgsmål til dig" calls for a "jeg" reply, while
  // "vi vil gerne høre jeres pris" obviously calls for "vi").
  const preview = (mail.preview ?? '').slice(0, 800);
  const userBlock = preview
    ? `Fra: ${mail.from}\nEmne: ${mail.subject}\n\nMailens indhold:\n${preview}\n\nSkriv et kort svar på dansk.`
    : `Fra: ${mail.from}\nEmne: ${mail.subject}\n\nSkriv et kort svar på dansk.`;
  return complete({
    model: DRAFT_MODEL,
    system: draftSystemPrompt(tone, userName),
    messages: [{ role: 'user', content: userBlock }],
    maxTokens: 160,
    temperature: 0.6,
    signal,
  });
}

export type InboxWaitingResult = Result<InboxMail[]> & {
  providerErrors: MailProviderError[];
  // Read but not user-dismissed. Rendered below `data` (the unread "venter
  // på dig" list) so the user sees their full inbox, not just unread —
  // matches the mental model of native Mail.app where read items remain
  // visible until explicitly archived.
  read: InboxMail[];
};

export function useInboxWaiting(): InboxWaitingResult {
  const { user } = useAuth();
  const demo = isDemoUser(user);
  const { items, loading, error, providerErrors } = useMailItems();
  const dismissed = useDismissedMailIds();
  const replied = useRepliedMailIds();
  const { data: workRows } = useWorkPreferences();
  const { data: profile } = useUser();
  const autonomy = prefValue(workRows, 'autonomy');
  const tone = prefValue(workRows, 'tone');
  const quietHours = prefValue(workRows, 'quiet-hours');
  const userName = profile?.name?.trim() ? profile.name.trim() : null;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Bumped when a classifier batch finishes (any verdict resolved). Used
  // purely to retrigger the urgency sort: verdict=true already re-renders
  // via setDrafts, but verdict=false silently updates the cache and would
  // leave the sort stale otherwise.
  const [verdictTick, setVerdictTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (demo) return;
    if (!hasClaudeKey() || items.length === 0) return;
    if (isInQuietHours(quietHours, new Date())) return;
    // Per-user caches require a uid. Without one we'd have nowhere to read
    // from or write to — bail rather than fall back to a global key.
    const uid = user?.id;
    if (!uid) return;

    const maxDrafts = AUTONOMY_TARGETS[autonomy] ?? AUTONOMY_TARGETS['Lav udkast'];
    if (maxDrafts === 0) return;

    const targets = items
      .filter(
        (m) =>
          !m.isRead &&
          !dismissed.has(m.id) &&
          needsReply(m.from) &&
          !looksLikeNonReplyContent(m.preview),
      )
      .slice(0, maxDrafts);
    if (targets.length === 0) return;

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    // Cache key includes the user name so a name change doesn't serve a
    // stale draft baked under a different identity. (Cross-account leakage
    // is already prevented at the storage layer — caches are keyed by
    // user_id in AsyncStorage.)
    const draftKey = (id: string) => `${id}::${tone || 'default'}::${userName ?? '_'}`;

    // Wait for both persisted caches to hydrate — otherwise every cold launch
    // re-pays for classifications and drafts AsyncStorage already has. Each
    // hydrate is per-user; switching accounts triggers a re-hydrate from the
    // new user's storage key (and clears the in-memory cache from the prior).
    void Promise.all([hydrateDraftCache(uid), hydrateVerdictCache(uid)]).then(async () => {
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
        // New verdicts in the cache → re-render so the urgency sort picks
        // them up. setDrafts further down only fires for needs-reply mails;
        // newsletter classifications wouldn't otherwise reach React state.
        setVerdictTick((t) => t + 1);
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
          generateDraft(m, tone, userName, controller.signal)
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
  }, [demo, items, autonomy, tone, quietHours, userName, user?.id]);

  if (demo) {
    return {
      data: demoInboxWaiting().filter((m) => !dismissed.has(m.id)),
      read: demoInboxArchived().filter((m) => !dismissed.has(m.id)),
      loading: false,
      error: null,
      providerErrors: [],
    };
  }

  const now = new Date();
  const tones: InboxMail['tone'][] = ['sage', 'clay', 'mist'];
  // Urgency tiers — drives the "sorteret efter hvad der haster" copy.
  // Two signal sources, both free at runtime:
  //   - Heuristics (sender pattern, body markers, subject keywords) — these
  //     run on EVERY fetched mail with zero extra cost.
  //   - Classifier verdicts from the AI-draft pipeline (cached per user
  //     for 24h) — only available for the top maxDrafts mails, but they
  //     trump the heuristics when present.
  //
  //   tier 0: classifier confirmed reply needed, OR subject contains a
  //           hard-urgency keyword (haster, akut, frist, urgent, …)
  //   tier 1: looks human, not yet classified — middle ground
  //   tier 2: classifier said no reply OR body looks automated
  //           (newsletter / verification / unsubscribe link)
  //   tier 3: from a no-reply sender (mailer-daemon, marketing@, …)
  // Date-desc within each tier.
  const sortedWaiting = items
    .filter((m) => !m.isRead && !dismissed.has(m.id) && !replied.has(m.id))
    .slice() // don't mutate the upstream array
    .sort((a, b) => {
      const ta = urgencyTier(a);
      const tb = urgencyTier(b);
      if (ta !== tb) return ta - tb;
      return b.receivedAt.getTime() - a.receivedAt.getTime();
    });
  // No global truncation: items is already capped per-provider at the fetch
  // layer (MAIL_FETCH_PER_PROVIDER = 50). Show every unread fetched so all
  // providers are visible regardless of recency skew.
  const data: InboxMail[] = sortedWaiting.map((m, i) => ({
    id: m.id,
    provider: m.provider,
    from: m.from,
    subject: m.subject,
    time: shortTime(m.receivedAt, now),
    tone: tones[i % tones.length],
    initials: initialsOf(m.from),
    aiDraft: drafts[m.id] ?? null,
    tier: urgencyTier(m),
  }));
  // Læst includes server-marked read mails AND mails the user has just
  // replied to in this session (locally tracked) — without the second
  // clause, replied-to Gmail/iCloud mails would vanish entirely (we have
  // no scope to set the read flag server-side for those providers).
  const read: InboxMail[] = items
    .filter((m) => !dismissed.has(m.id) && (m.isRead || replied.has(m.id)))
    .map((m, i) => ({
      id: m.id,
      provider: m.provider,
      from: m.from,
      subject: m.subject,
      time: shortTime(m.receivedAt, now),
      tone: tones[i % tones.length],
      initials: initialsOf(m.from),
      aiDraft: null,
      tier: urgencyTier(m),
    }));
  return { data, read, loading, error, providerErrors };
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
      tier: urgencyTier(m),
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

    const task: Promise<MailDetail> =
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
        : provider === 'microsoft'
        ? graphGetMessageBody(id).then((b): MailDetail => ({
            id: b.id,
            provider: 'microsoft',
            from: b.from,
            subject: b.subject,
            body: b.text,
            replyContext: { provider: 'microsoft', messageId: b.id },
          }))
        : (async (): Promise<MailDetail> => {
            // 'icloud' branch — id format is `icloud:<uid>` from useMailItems.
            const uidStr = id.startsWith('icloud:') ? id.slice('icloud:'.length) : id;
            const uid = Number(uidStr);
            if (!Number.isFinite(uid)) throw new Error('invalid icloud uid');
            const userId = user?.id ?? '';
            const r = await getIcloudMessageBody(userId, uid);
            if (!r.ok) throw new Error(`icloud:${r.error}`);
            return {
              id,
              provider: 'icloud',
              from: r.data.from,
              subject: r.data.subject,
              body: r.data.body,
              replyContext: {
                provider: 'icloud',
                uid,
                subject: r.data.subject,
                fromEmail: r.data.fromEmail,
              },
            };
          })();

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
        markMailReplied(mailId);
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
          await recordSentMailSafe(user?.id ?? null, {
            provider: 'google',
            to: [ctx.replyTo],
            subject: ctx.subject,
            body,
            replyToId: mailId,
          });
        } else if (ctx.provider === 'microsoft') {
          await graphReplyToMessage(ctx.messageId, body);
          await recordSentMailSafe(user?.id ?? null, {
            provider: 'microsoft',
            to: [],          // graphReplyToMessage uses the original recipients server-side
            subject: '',     // not exposed via this code path; keep empty for the log
            body,
            replyToId: mailId,
          });
        } else {
          if (!user?.id) throw new Error('Ikke logget ind.');
          if (!ctx.fromEmail) throw new Error('Manglende afsender-adresse.');
          const replySubject = /^re:/i.test(ctx.subject.trim())
            ? ctx.subject.trim()
            : `Re: ${ctx.subject.trim()}`;
          const r = await icloudSendMail(user.id, {
            to: [ctx.fromEmail],
            subject: replySubject,
            body,
            replyToUid: ctx.uid,
          });
          if (!r.ok) throw new Error(`icloud:${r.error}`);
          await recordSentMailSafe(user.id, {
            provider: 'icloud',
            to: [ctx.fromEmail],
            subject: replySubject,
            body,
            replyToId: mailId,
          });
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (__DEV__) console.warn('[hooks] send reply failed:', e.message);
        setError(e);
        setSending(false);
        return false;
      }

      // Send succeeded. Archive is best-effort — a failure here still counts
      // as success because the reply went out. Only Microsoft archives
      // server-side; Google archive needs gmail.modify which we don't request,
      // so the original message stays in the Gmail inbox after reply.
      try {
        if (ctx.provider === 'microsoft') {
          await graphArchiveMessage(mailId);
        }
      } catch (err) {
        if (__DEV__) console.warn('[hooks] archive after send failed:', err);
      }

      markMailReplied(mailId);
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
        if (provider === 'microsoft') {
          await graphArchiveMessage(mailId);
        } else {
          // Google and iCloud archive are local-only dismissal:
          // Google requires gmail.modify scope which we don't request
          // (we use gmail.readonly + gmail.compose). iCloud has no
          // markAsArchived equivalent in our IMAP proxy. UI updates,
          // server state unchanged.
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
  // Calendar tab honors the visibility picker; brief / today / chat
  // (other useCalendarItems consumers) keep the legacy primary-only fetch.
  const { items, loading, error } = useCalendarItems(
    bounds?.start.getTime(),
    bounds?.end.getTime(),
    true,
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
  { id: 'onedrive', title: 'OneDrive', sub: 'Søger og læser tekstfiler', status: 'disconnected', logo: 'onedrive.png' },
];

const GOOGLE_INTEGRATIONS = new Set<Connection['id']>(['google-calendar', 'gmail', 'google-drive']);
const MICROSOFT_INTEGRATIONS = new Set<Connection['id']>(['outlook-calendar', 'outlook-mail', 'onedrive']);

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
  const { isEnabled, setEnabled } = useIntegrationFlags();

  // status === 'connected' means the user has BOTH a parent OAuth grant AND
  // hasn't toggled this specific integration off. Demo bypasses the flag
  // store — DEMO_CONNECTIONS hard-codes statuses.
  const data: Connection[] = demo
    ? DEMO_CONNECTIONS
    : DEFAULT_CONNECTIONS.map((c) => {
        const tokenPresent =
          (GOOGLE_INTEGRATIONS.has(c.id) && !!googleAccessToken) ||
          (MICROSOFT_INTEGRATIONS.has(c.id) && !!microsoftAccessToken);
        if (tokenPresent && isEnabled(c.id, true)) {
          return { ...c, status: 'connected' as const };
        }
        return c;
      });

  const connect = async (
    id: Connection['id'],
  ): Promise<{
    data: unknown;
    error: Error | null;
    adminConsent?: { tenantHint?: string };
    cancelled?: boolean;
  }> => {
    if (demo) return { data: null, error: null };
    if (GOOGLE_INTEGRATIONS.has(id)) return signInWithGoogle();
    if (MICROSOFT_INTEGRATIONS.has(id)) {
      const result = await signInWithMicrosoft();
      // Redirect-with-error path: AAD bounced with an admin-consent code.
      if (result.error) {
        const detection = detectAdminConsentRequired(result.error.message);
        if (detection.detected) {
          return { ...result, adminConsent: { tenantHint: detection.tenantHint } };
        }
      }
      // Cancel path: WebBrowser closed without error and we have no
      // microsoftAccessToken yet (the OAuth never completed). Surface a
      // `cancelled` flag so the caller can ask the user whether the cancel
      // was an admin-consent dead-end.
      if (!result.error && !result.data) {
        return { ...result, cancelled: true };
      }
      return result;
    }
    return { data: null, error: new Error('Ukendt integration.') };
  };

  const disconnect = async (id: Connection['id']): Promise<{ error: Error | null }> => {
    try {
      if (GOOGLE_INTEGRATIONS.has(id)) {
        await disconnectProvider('google');
        // Clear the per-integration flags too so a re-grant starts from
        // default-on rather than inheriting a previous explicit "off".
        await clearIntegrationFlags(['gmail', 'google-calendar', 'google-drive']);
      } else if (MICROSOFT_INTEGRATIONS.has(id)) {
        await disconnectProvider('microsoft');
        await clearIntegrationFlags(['outlook-mail', 'outlook-calendar', 'onedrive']);
      } else {
        return { error: new Error('Ukendt integration.') };
      }
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  };

  return {
    data,
    loading: false,
    error: null as Error | null,
    connect,
    disconnect,
    // Per-integration software toggle. Use this for "turn off Gmail without
    // revoking Calendar" — the OAuth grant stays intact. Use `disconnect`
    // (above) when you want to revoke the entire provider grant.
    setEnabled,
    googleAccessToken,
    microsoftAccessToken,
  };
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
    id: 'midday-brief',
    title: 'Middagsoverblik',
    meta: 'Hvad ligger der efter frokost?',
    value: 'Fra',
    options: ['Fra', '11.30', '12.00', '12.30', '13.00'],
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
  const userId = user?.id ?? null;
  const demo = isDemoUser(user);
  const [reminders, setReminders] = useState<Reminder[]>(() =>
    demo ? demoReminders() : [],
  );
  const [loading, setLoading] = useState(!demo);

  const refresh = useCallback(async () => {
    if (demo) { setReminders(demoReminders()); setLoading(false); return; }
    if (!userId) { setReminders([]); setLoading(false); return; }
    try {
      const next = await listAllReminders(userId);
      setReminders(next);
    } catch (err) {
      if (__DEV__) console.warn('[useReminders] refresh failed:', err);
    } finally {
      setLoading(false);
    }
  }, [demo, userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const markDone = useCallback(async (id: string) => {
    if (demo) {
      setReminders((p) =>
        p.map((r) => r.id === id ? { ...r, status: 'done' as const, doneAt: new Date() } : r));
      return;
    }
    await markReminderDone(id);
    await refresh();
  }, [demo, refresh]);

  const remove = useCallback(async (id: string) => {
    if (demo) { setReminders((p) => p.filter((r) => r.id !== id)); return; }
    await deleteReminder(id);
    await refresh();
  }, [demo, refresh]);

  const add = useCallback(async (text: string, dueAt?: Date): Promise<Reminder> => {
    if (demo) {
      const r: Reminder = {
        id: `d-r-${Date.now()}`,
        text,
        dueAt: dueAt ?? null,
        status: 'pending',
        createdAt: new Date(),
        doneAt: null,
        firedAt: null,
        scheduledForTz: null,
      };
      setReminders((p) => [...p, r]);
      return r;
    }
    if (!userId) throw new Error('useReminders.add: no user');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await addReminder(userId, text, dueAt ?? null, tz);
    await refresh();
    return r;
  }, [demo, refresh, userId]);

  return { data: reminders, loading, error: null as Error | null, markDone, remove, add };
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

// Build a Danish summary of which integrations are currently OFF, so the
// model refuses to act on cached data from earlier turns. Without this, a
// previous tool result (e.g. Gmail messages) is still in the conversation
// history and the model will happily paraphrase it on later turns even
// after the user toggled the integration off.
function buildDisabledIntegrationsBlock(ctx: ChatCtx): string {
  const labels: { key: keyof ChatCtx; label: string }[] = [
    { key: 'gmail', label: 'Gmail' },
    { key: 'googleCalendar', label: 'Google Kalender' },
    { key: 'googleDrive', label: 'Google Drive' },
    { key: 'outlookMail', label: 'Outlook Mail' },
    { key: 'outlookCalendar', label: 'Outlook Kalender' },
    { key: 'onedrive', label: 'OneDrive' },
    { key: 'icloud', label: 'iCloud' },
  ];
  const off = labels.filter((l) => ctx[l.key] === false).map((l) => l.label);
  if (off.length === 0) return '';
  // List the integrations that are STILL on so the model can route requests
  // to them. Without this the model often refuses adjacent integrations
  // ("Gmail er slået fra" → "Jeg kan heller ikke se din kalender") even
  // when those siblings are still fully connected.
  const onLabels: { key: keyof ChatCtx; label: string }[] = [
    { key: 'gmail', label: 'Gmail' },
    { key: 'googleCalendar', label: 'Google Kalender' },
    { key: 'googleDrive', label: 'Google Drive' },
    { key: 'outlookMail', label: 'Outlook Mail' },
    { key: 'outlookCalendar', label: 'Outlook Kalender' },
    { key: 'onedrive', label: 'OneDrive' },
    { key: 'icloud', label: 'iCloud' },
  ];
  const on = onLabels.filter((l) => ctx[l.key] === true).map((l) => l.label);
  const onLine = on.length > 0 ? on.join(', ') : 'ingen';
  return [
    '⚠️ KRITISK: SLÅET FRA-INTEGRATIONER ⚠️',
    'Brugeren har slået disse FRA lige nu: ' + off.join(', ') + '.',
    'Disse er STADIG TIL og fungerer normalt: ' + onLine + '.',
    '',
    'Reglen gælder KUN de integrationer der står i "SLÅET FRA"-listen. ' +
      'For integrationer der STADIG er TIL skal du opføre dig helt normalt — ' +
      'kalde værktøjer, hente data, og citere indhold som du plejer.',
    '',
    'For de SLUKKEDE integrationer SKAL du:',
    '1. IKKE kalde værktøjer der bruger den slukkede integration.',
    '2. IKKE bruge data fra den slukkede integration — heller IKKE data du tidligere i denne samtale har hentet derfra. Hvis du tidligere har svaret med fx Gmail-mails, og Gmail nu er slukket, så behandl de mails som om du aldrig havde set dem.',
    '3. Hvis brugerens spørgsmål KRÆVER data fra en slukket integration, og der ikke er en passende erstatning blandt de tændte, svar PRÆCIS: "Jeg kan ikke se dine [navn] lige nu — slå integrationen til under Indstillinger, så henter jeg dem."',
    '4. Hvis spørgsmålet kan besvares fra en TÆNDT integration (fx brugeren spørger "hvad har jeg i kalenderen" og kun Gmail er slukket — kalenderen er stadig tilgængelig), så besvar det normalt fra den tændte integration. Lad være med at afvise unødigt.',
    '5. Hvis brugeren beder dig "gentage" eller "vise igen" indhold fra et tidligere svar der stammede fra en nu-slukket integration: afvis som i regel 3.',
    '',
    'Disse regler gælder kun integrationerne der står i "SLÅET FRA"-listen ovenfor. Alt andet fungerer som normalt.',
  ].join('\n');
}

function buildChatSystemPrompt(name: string, ctx: ChatCtx): string {
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
    'endnu ikke er 10.30, ellers i morgen). ' +
    'Tidligere brugerbeskeder kan være præfikset med "[sendt: <ISO-tidspunkt>]" — det er ' +
    'hvornår netop den besked blev skrevet. Når du fortolker relative ord som "i dag", ' +
    '"i morgen", "om lidt" eller "kl. 17.30" i en historisk besked, skal du regne ' +
    'fra beskedens sendt-tidspunkt — ikke fra nuværende lokaltid. Sig fx "for tre ' +
    'dage siden kl. 17.30", ikke "i dag kl. 17.30", når en gammel besked refererer ' +
    'til "i dag" på et tidspunkt der allerede er passeret. Skriv ALDRIG selv ' +
    '"[sendt: ...]" i dine svar — præfikset gælder kun historiske brugerbeskeder.';
  return [
    'Du er Zolva, en venlig og omsorgsfuld dansk personlig assistent.',
    'Du svarer altid på dansk i en varm, jordnær og let uformel tone.',
    'ADRESSERINGSKRAV: Skriv ALTID direkte med "du"/"dig"/"din". ' +
      'Omtal ALDRIG personen i 3. person ved navn eller pronomen — skriv ' +
      '"Du har et møde kl. 14", IKKE "Albert har et møde" eller "Han har et møde". ' +
      'Navnet må kun forekomme i en hilsen eller når det citeres tilbage som ' +
      'noget der er skrevet til dig — aldrig som omtale. ' +
      'Skriv ALDRIG ordene "bruger", "brugeren", "brugerens" eller "brugere" i ' +
      'dit svar — det her er en samtale mellem dig og personen, ikke en ' +
      'beskrivelse af nogen i 3. person. Denne regel gælder ALLE svar, ' +
      'også systemmeddelelser, fejltekster og bekræftelser.',
    intro,
    buildDisabledIntegrationsBlock(ctx),
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
    'Når brugeren spørger om sin kalender, sit overblik for dagen/ugen, fri tid, ' +
      'travle perioder eller "hvor har jeg flaskehalse?", brug list_calendar_events. ' +
      'Vælg `from`/`to` ud fra spørgsmålet (i dag, denne uge, næste 7 dage, osv.) — ' +
      'hold intervallet under 30 dage. Hvis brugeren ikke specificerer, brug i dag.',
    'Kalenderværktøjet henter fra Google, Outlook og iCloud automatisk afhængigt af ' +
      'hvilke der er forbundet — inkl. sekundære Google-kalendere (Family, Arbejde osv.). ' +
      'Begivenheder er taggede med kalendernavn i parentes når de kommer fra en sub-kalender. ' +
      'Hvis en kilde mislykkedes, står det i fodlinjen — nævn det kun for brugeren hvis ' +
      'det er relevant for svaret.',
    'Når brugeren spørger "hvilke kalendere har jeg?" eller henviser til en specifik ' +
      'kalender ved navn ("læg det i Family", "i min Arbejde-kalender"), brug list_calendars ' +
      'for at hente listen. Sig ALDRIG "jeg kan ikke se dine kalendere" uden først at have ' +
      'kaldt list_calendars.',
    'Når brugeren spørger om mail, brug list_recent_mail for et hurtigt overblik. ' +
      'Brug read_mail_thread KUN hvis brugeren beder om indholdet af en specifik mail, ' +
      'eller hvis du har brug for fuld tekst for at svare præcist. ' +
      'list_recent_mail og read_mail_thread henter fra Gmail, Outlook OG iCloud ' +
      'automatisk afhængigt af hvilke der er forbundet — du har altid adgang til ' +
      'at læse mails så længe brugeren har mindst én postkasse forbundet. Sig ALDRIG ' +
      '"jeg kan ikke læse din mail" uden først at have prøvet list_recent_mail.',
    'Brug aldrig kalender- eller mail-værktøjer til at gætte fremtidige eller fortidige ' +
      'data — kun konkret det brugeren spørger om i dette øjeblik.',
    'OPRET BEGIVENHEDER UDEN AT SPØRGE: Når brugeren har angivet titel og tidspunkt — fx ' +
      '"lav et event til imorgen kl 17 kald det møde med karl" — kald create_calendar_event ' +
      'med det samme. Spørg IKKE om varighed (brug 1 time som default), sted, beskrivelse, ' +
      'deltagere eller hvilken kalender. De felter brugeren ikke nævnte skal du IKKE fylde ud — ' +
      'lad dem være tomme. Sig kort hvad du oprettede ("Lavet: møde med karl i morgen kl. 17-18") ' +
      'så brugeren kan korrigere.',
    'PROVIDER VÆLGES AUTOMATISK: Vælg `provider` i denne prioriterede rækkefølge blandt de ' +
      'forbundne: google > microsoft > icloud. Spørg ALDRIG brugeren hvilken kalender — ' +
      'medmindre de selv har nævnt en specifik. Ved opdatering/sletning bestemmes provideren ' +
      'af unified-ID-præfikset.',
    'SUB-KALENDER (calendar_id): Hvis brugeren har nævnt en specifik kalender ved navn — fx ' +
      '"læg det i Family", "i min Arbejde-kalender", "i oioioi" — send navnet ELLER ID\'et ' +
      'som `calendar_id` på create_calendar_event. Værktøjet matcher selv navnet til den ' +
      'rigtige kalender (case-insensitive). Du behøver IKKE kalde list_calendars først bare ' +
      'for at få ID\'et — bare send navnet brugeren brugte. Hvis brugeren ikke har nævnt ' +
      'en specifik kalender, udelad `calendar_id` (lægger i provider-default).',
    'SPØRG KUN HVIS DET ER UMULIGT AT GÆTTE: Hvis tidspunktet er reelt tvetydigt ' +
      '("næste uge" uden ugedag, "om eftermiddagen" uden klokkeslæt) eller titlen mangler ' +
      'helt, så spørg. Ellers bare opret. Detaljer som lokation/deltagere/beskrivelse ' +
      'tilføjer brugeren selv hvis de er vigtige — spørg dem aldrig om det.',
    'KONFLIKTTJEK: create_calendar_event tjekker selv for overlap på tværs af ALLE ' +
      'forbundne kalendere før det opretter. Hvis værktøjet returnerer en KONFLIKT-besked, ' +
      'fortæl brugeren hvilke eksisterende begivenheder der ligger i samme tidsrum og spørg ' +
      'om de vil oprette alligevel eller flytte til et andet tidspunkt. Hvis brugeren ' +
      'bekræfter at oprette alligevel, kald create_calendar_event igen med præcis samme ' +
      'felter PLUS `force_overlap: true`. Hvis brugeren vælger et nyt tidspunkt, kald med ' +
      'de nye tider og UDEN force_overlap.',
    'iCloud understøtter ikke deltagere/invitationer endnu — hvis brugeren beder om ' +
      'at invitere folk til en iCloud-begivenhed, foreslå Outlook eller Google i stedet, ' +
      'eller opret begivenheden uden deltagere.',
    'Når brugeren spørger om indhold i deres fil-arkiver — fx "hvad stod der i Q2-' +
      'budgettet?", "find notatet om Lars", "hvad aftalte vi om projektet?" — brug ' +
      'først search_drive_files (Google Drive) og/eller search_onedrive_files ' +
      '(OneDrive) med korte præcise søgeord. Læs derefter den mest relevante fil ' +
      'med read_drive_file eller read_onedrive_file. Citér ALTID kilden ved navn ' +
      'og link når du svarer på baggrund af en fil — fx "(kilde: Filnavn — link)". ' +
      'Læs højst 2-3 filer per spørgsmål for at holde svaret fokuseret. Hvis ' +
      'brugeren ikke specificerer hvilken sky, søg i den/dem der er forbundet ' +
      '(Google Drive kræver Google-login, OneDrive kræver Microsoft-login).',
    'Drive- og OneDrive-værktøjer er read-only — du kan ikke oprette, redigere ' +
      'eller slette filer. Forklar det hvis brugeren beder om det.',
    'OneDrive-tekstudtræk understøtter lige nu kun rene tekstfiler (txt, markdown, ' +
      'csv, json, html, xml). Word, Excel, PowerPoint og PDF kommer senere — hvis ' +
      'brugeren spørger om indhold i et Office-dokument fra OneDrive, forklar det ' +
      'kort og foreslå evt. at åbne filen direkte via det link søgeresultatet gav.',
    'OPRET MAIL UDEN AT SPØRGE: Når brugeren har angivet modtager og hvad der skal stå — fx ' +
      '"send en mail til lars at jeg er forsinket" — kald værktøjet med det samme. Skriv selv ' +
      'et passende emne og en kort, naturlig brødtekst. Spørg IKKE om emne, CC, hvilken ' +
      'mailkonto eller om brugeren er sikker. Sig kort hvad du oprettede/sendte ' +
      '("Sendt til lars@…: \'Forsinket\' – Hej Lars, jeg er ca. 15 min forsinket.") så ' +
      'brugeren kan korrigere.',
    'UDKAST vs SEND: Brug create_draft som default. Brug KUN send_mail når brugeren ' +
      'udtrykkeligt skriver "send", "afsend" eller "send afsted". Ved "skriv", "lav et ' +
      'udkast", "udarbejd" → create_draft. Ved tvivl → create_draft (det kan altid sendes ' +
      'manuelt, en fejlsendt mail kan ikke).',
    'PROVIDER VÆLGES AUTOMATISK: Vælg `provider` i denne prioriterede rækkefølge blandt ' +
      'de forbundne: google > microsoft > icloud. Spørg ALDRIG brugeren hvilken konto.',
    'SPØRG KUN HVIS DET ER UMULIGT: Hvis modtageren mangler ("send en mail om mødet" uden ' +
      'navn) eller indholdet er reelt tomt ("skriv en mail til Lars" uden tema), så spørg. ' +
      'Ellers bare gør det.',
    'Hvis udkastet/sendingen er et SVAR på en eksisterende mail (brugeren henviser ' +
      'til en mail de har modtaget), så send det fulde unified-ID i `reply_to_id` ' +
      '(fx "google:abc", "microsoft:abc" eller "icloud:123") — så bevares tråden korrekt. ' +
      'Brug list_recent_mail eller read_mail_thread til at finde det rigtige ID.',
    'Skriv ALDRIG en signatur/underskrift selv i `body` — Zolva tilføjer ' +
      'automatisk brugerens egen signatur. Skriv kun selve beskeden.',
  ]
    .filter(Boolean)
    .join(' ');
}

function messageSentAt(m: ChatMessage): string | null {
  if (m.createdAt) return m.createdAt;
  const match = m.id.match(/^[uae]-(\d+)$/);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  }
  return null;
}

// Filter the tools list so the model only sees tools whose required
// integrations are currently enabled. Without this, the model sees
// `search_drive_files` in its toolbox and confidently answers "yes I can
// search your Drive" even when Drive is toggled off — a capability claim
// that doesn't require a tool call to leak. Removing the tool from the
// schema is the only deterministic way to stop that.
function filterToolsByCtx(
  tools: ClaudeToolSchema[],
  ctx: ChatCtx,
): ClaudeToolSchema[] {
  const anyMail = ctx.gmail || ctx.outlookMail || ctx.icloud;
  const anyCal = ctx.googleCalendar || ctx.outlookCalendar || ctx.icloud;
  const anyComposeMail = ctx.gmail || ctx.outlookMail || ctx.icloud;
  return tools.filter((t) => {
    switch (t.name) {
      // Drive / OneDrive — single-integration tools
      case 'search_drive_files':
      case 'read_drive_file':
        return ctx.googleDrive;
      case 'search_onedrive_files':
      case 'read_onedrive_file':
        return ctx.onedrive;
      // Mail read/list — needs any mail provider
      case 'list_recent_mail':
      case 'read_mail_thread':
        return anyMail;
      // Calendar read/write — needs any calendar provider
      case 'list_calendars':
      case 'list_calendar_events':
      case 'create_calendar_event':
      case 'update_calendar_event':
      case 'delete_calendar_event':
        return anyCal;
      // Mail compose — needs any mail provider
      case 'create_draft':
      case 'send_mail':
        return anyComposeMail;
      // Local-only tools (reminders, notes) are always available.
      default:
        return true;
    }
  });
}

function disabledLabelsForCtx(ctx: ChatCtx): string[] {
  const labels: { key: keyof ChatCtx; label: string }[] = [
    { key: 'gmail', label: 'Gmail' },
    { key: 'googleCalendar', label: 'Google Kalender' },
    { key: 'googleDrive', label: 'Google Drive' },
    { key: 'outlookMail', label: 'Outlook Mail' },
    { key: 'outlookCalendar', label: 'Outlook Kalender' },
    { key: 'onedrive', label: 'OneDrive' },
    { key: 'icloud', label: 'iCloud' },
  ];
  return labels.filter((l) => ctx[l.key] === false).map((l) => l.label);
}

function toClaudeMessages(messages: ChatMessage[], ctx: ChatCtx): ClaudeMessage[] {
  const slice = messages.slice(-CHAT_API_CONTEXT_LIMIT);
  const offLabels = disabledLabelsForCtx(ctx);
  // Find the index of the latest user message; we inject the disabled-
  // integrations reminder right next to it. Models attend most strongly
  // to the most recent user turn — putting the reminder there is far
  // harder to ignore than the system prompt alone, which has to compete
  // with prior assistant text that might paraphrase data the user just
  // toggled off.
  let lastUserIdx = -1;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    if (slice[i].from === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  return slice.map((m, idx) => {
    const role = m.from === 'user' ? 'user' : 'assistant';
    const sentAt = role === 'user' ? messageSentAt(m) : null;
    let content = sentAt ? `[sendt: ${sentAt}] ${m.text}` : m.text;
    if (idx === lastUserIdx && offLabels.length > 0) {
      const onForReminder: { key: keyof ChatCtx; label: string }[] = [
        { key: 'gmail', label: 'Gmail' },
        { key: 'googleCalendar', label: 'Google Kalender' },
        { key: 'googleDrive', label: 'Google Drive' },
        { key: 'outlookMail', label: 'Outlook Mail' },
        { key: 'outlookCalendar', label: 'Outlook Kalender' },
        { key: 'onedrive', label: 'OneDrive' },
        { key: 'icloud', label: 'iCloud' },
      ];
      const stillOn = onForReminder.filter((l) => ctx[l.key] === true).map((l) => l.label);
      const onPart = stillOn.length > 0 ? stillOn.join(', ') : 'ingen';
      content =
        `[PÅMINDELSE: ${offLabels.join(', ')} er slået FRA. Stadig TIL: ${onPart}. ` +
        'Reglen gælder KUN de slukkede — brug ikke data derfra (heller ikke ' +
        'data fra tidligere svar i denne samtale). De tændte integrationer ' +
        'fungerer helt normalt; svar ud fra dem hvis det giver mening.]\n\n' +
        content;
    }
    return { role, content };
  });
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
  {
    name: 'list_calendars',
    description:
      'Hent navnene på alle kalendere brugeren har forbundet — Google Kalender (inkl. sekundære kalendere som Family, Arbejde osv.), Outlook og iCloud. Returnerer navn, ID og farve per kalender. Brug værktøjet når brugeren spørger "hvilke kalendere har jeg?" eller når de vil oprette en begivenhed i en specifik kalender ("læg det i Family"). ID-delen efter kolonet sendes som `calendar_id` på create_calendar_event for at ramme den rigtige kalender.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_calendar_events',
    description:
      'Hent brugerens kalenderbegivenheder fra alle forbundne kalendere (Google Kalender, Outlook, iCloud) i et tidsinterval. Brug til at give overblik, finde fri tid, eller analysere hvor brugeren har travlt. Returnerer kompakt liste med ID, tid, titel, sted og deltagerantal — ikke fuld beskrivelse.',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            'ISO 8601 startdato/tid med tidszone-offset (fx "2026-04-28T00:00:00+02:00"). Inklusivt.',
        },
        to: {
          type: 'string',
          description:
            'ISO 8601 slutdato/tid med tidszone-offset. Eksklusivt. Hold intervallet under 30 dage.',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'list_recent_mail',
    description:
      'Hent de nyeste mails fra alle forbundne postkasser (Gmail, Outlook, iCloud). Returnerer afsender, emne og kort uddrag — IKKE hele beskeden. Brug read_mail_thread til fuld tekst.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Antal mails samlet, default 10, max 30.',
        },
      },
    },
  },
  {
    name: 'read_mail_thread',
    description:
      'Hent fuld tekst af én specifik mail. Brug ID returneret af list_recent_mail (fx "google:abc123" eller "icloud:42").',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Det fulde unified-ID, fx "google:1234abc".' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_calendar_event',
    description:
      'Opret en ny kalenderbegivenhed. Kald værktøjet UDEN at spørge når brugeren har givet titel og tid — brug 1 time som default-varighed og fyld kun ekstra felter ud hvis brugeren har nævnt dem. Understøtter Google Kalender (google), Outlook (microsoft) og iCloud. Tider skal være ISO 8601 med tidszone-offset, og slut skal ligge efter start. Værktøjet tjekker selv for konflikter på tværs af alle forbundne kalendere — hvis der er overlap, returnerer det en KONFLIKT-besked og opretter IKKE begivenheden. Bemærk: iCloud understøtter ikke deltager-invitationer endnu.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['google', 'microsoft', 'icloud'], description: 'Hvilken kalender begivenheden lægges i. Vælg automatisk i prioriteret rækkefølge: google > microsoft > icloud blandt de forbundne — spørg ikke brugeren.' },
        title: { type: 'string', description: 'Begivenhedens titel.' },
        start: { type: 'string', description: 'ISO 8601 startdato/tid med tidszone-offset.' },
        end: { type: 'string', description: 'ISO 8601 slutdato/tid med tidszone-offset. Default: start + 1 time hvis brugeren ikke nævnte varighed.' },
        all_day: { type: 'boolean', description: 'true for hele-dagen-begivenhed.' },
        location: { type: 'string' },
        description: { type: 'string' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email-adresser på deltagere (kun Outlook — iCloud-invitationer understøttes ikke endnu).',
        },
        force_overlap: {
          type: 'boolean',
          description: 'Sæt til true KUN hvis et tidligere kald returnerede KONFLIKT og brugeren udtrykkeligt har bekræftet at de vil oprette alligevel. Springer konflikttjekket over.',
        },
        calendar_id: {
          type: 'string',
          description: 'Specifik sub-kalender at oprette i. Accepterer ENTEN kalenderens navn ("oioioi", "Family") ELLER det fulde id (fx "abc@group.calendar.google.com" for Google, lang opaque streng for Outlook, CalDAV-URL for iCloud). Værktøjet matcher selv navne mod brugerens kalendere (case-insensitive). Udelad for provider-default (Google primary, Outlook default, iCloud først). Brug KUN når brugeren udtrykkeligt har nævnt en specifik kalender.',
        },
      },
      required: ['provider', 'title', 'start', 'end'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Opdater en eksisterende kalenderbegivenhed. Kald værktøjet UDEN at spørge når brugeren har angivet hvad der skal ændres ("flyt mødet til kl. 18", "kald den i stedet for X"). Brug det fulde unified-ID fra list_calendar_events ("google:...", "microsoft:..." eller "icloud:..."). Kun de felter der specifices bliver ændret. Hvis start ændres skal end også sendes (og omvendt). Sig kort hvad du ændrede så brugeren kan korrigere.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unified-ID, fx "google:abc", "microsoft:abc" eller "icloud:UID-string".' },
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 — kun hvis du også sender end.' },
        end: { type: 'string', description: 'ISO 8601 — kun hvis du også sender start.' },
        all_day: { type: 'boolean' },
        location: { type: 'string' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Slet en kalenderbegivenhed. BEKRÆFT MED BRUGEREN FØRST — sletning kan ikke fortrydes via Zolva. Brug unified-ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'search_drive_files',
    description:
      'Søg i brugerens Google Drive efter filer der matcher et søgeord — både i filindhold (Docs, Sheets, Slides, tekst) og filnavne. Returnerer en kompakt liste med ID, type, navn, ændringsdato, ejer og link. Brug read_drive_file for at hente selve indholdet af én specifik fil. Brug korte præcise søgeord (1-3 ord) — Drive matcher hele ord, ikke fragmenter.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Søgeord (fx "Q2 budget", "Lars projektplan").' },
        limit: { type: 'number', description: 'Max antal hits (1-25, default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_drive_file',
    description:
      'Hent tekstindholdet af én specifik Drive-fil. Brug ID returneret af search_drive_files (fx "drive:abc123" — send kun delen efter "drive:"). Understøtter Google Docs, Sheets (som CSV), Slides, og rene tekstfiler. PDF og binære formater afvises. Lange filer afkortes til ca. 12.000 tegn.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Drive fil-ID (delen efter "drive:" i unified-ID).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'search_onedrive_files',
    description:
      'Søg i brugerens OneDrive (Microsoft) efter filer der matcher et søgeord — både filnavne og indekseret filindhold. Returnerer en kompakt liste med ID, type, navn, ændringsdato og link. Brug read_onedrive_file for at hente selve indholdet af én specifik fil. Brug korte præcise søgeord (1-3 ord).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Søgeord (fx "Q2 budget", "Lars projektplan").' },
        limit: { type: 'number', description: 'Max antal hits (1-25, default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_onedrive_file',
    description:
      'Hent tekstindholdet af én specifik OneDrive-fil. Brug ID returneret af search_onedrive_files (fx "onedrive:01ABC..." — send kun delen efter "onedrive:"). Understøtter rene tekstfiler (txt, markdown, csv, json, html, xml). Word/Excel/PowerPoint og PDF afvises lige nu. Lange filer afkortes til ca. 12.000 tegn.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'OneDrive fil-ID (delen efter "onedrive:" i unified-ID).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_draft',
    description:
      'Opret et udkast til en mail. Brug når brugeren siger "lav et udkast", "skriv en mail", "udarbejd et svar" eller lignende. Udkastet gemmes i brugerens mailkonto (Gmail, Outlook eller iCloud) — det bliver IKKE sendt. Kald værktøjet UDEN at spørge når brugeren har givet modtager + indhold; skriv selv et passende emne hvis det mangler. Brugerens signatur tilføjes automatisk. Hvis udkastet er et svar på en eksisterende mail, send det fulde unified-ID i `reply_to_id` (fx "google:abc", "microsoft:abc" eller "icloud:123") — så bevares tråden.',
    input_schema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['google', 'microsoft', 'icloud'],
          description: 'Hvilken konto udkastet lægges på. Vælg ud fra hvor brugeren har konteksten.',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modtager-mailadresser. Mindst én.',
        },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Mailens brødtekst. Tilføj IKKE underskrift selv — den bliver hentet og lagt på automatisk.' },
        reply_to_id: { type: 'string', description: 'Unified-ID fra list_recent_mail/read_mail_thread hvis det er et svar.' },
      },
      required: ['provider', 'to', 'subject', 'body'],
    },
  },
  {
    name: 'send_mail',
    description:
      'Send en mail med det samme. Brug KUN når brugeren udtrykkeligt siger "send", "afsend" eller "send afsted" — IKKE ved "udkast", "skriv", eller "lav et svar". Når i tvivl, brug create_draft. Kald værktøjet UDEN at spørge når brugeren har givet modtager + indhold; skriv selv et passende emne hvis det mangler. Brugerens signatur tilføjes automatisk. Sig kort hvad du sendte så brugeren kan se det er afgået korrekt.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['google', 'microsoft', 'icloud'] },
        to: { type: 'array', items: { type: 'string' } },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        reply_to_id: { type: 'string', description: 'Unified-ID hvis det er et svar — så bevares tråden.' },
      },
      required: ['provider', 'to', 'subject', 'body'],
    },
  },
];

function parseDate(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; reason: string };

function parseWriteInput(input: Record<string, unknown>): ParseResult<WriteEventInput> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) return { ok: false, reason: 'Mangler `title`.' };
  const start = parseDate(input.start);
  const end = parseDate(input.end);
  if (!start) return { ok: false, reason: 'Ugyldig `start` — brug ISO 8601 med tidszone-offset.' };
  if (!end) return { ok: false, reason: 'Ugyldig `end` — brug ISO 8601 med tidszone-offset.' };
  if (end.getTime() <= start.getTime()) return { ok: false, reason: '`end` skal ligge efter `start`.' };
  const data: WriteEventInput = {
    title,
    start,
    end,
    allDay: typeof input.all_day === 'boolean' ? input.all_day : undefined,
    location: typeof input.location === 'string' ? input.location : undefined,
    description: typeof input.description === 'string' ? input.description : undefined,
    attendees: parseStringArray(input.attendees),
    forceOverlap: typeof input.force_overlap === 'boolean' ? input.force_overlap : undefined,
    calendarId:
      typeof input.calendar_id === 'string' && input.calendar_id.trim()
        ? input.calendar_id.trim()
        : undefined,
  };
  return { ok: true, data };
}

function parseWritePatch(input: Record<string, unknown>): ParseResult<Partial<WriteEventInput>> {
  const patch: Partial<WriteEventInput> = {};
  if (typeof input.title === 'string') patch.title = input.title;
  if (typeof input.location === 'string') patch.location = input.location;
  if (typeof input.description === 'string') patch.description = input.description;
  if (typeof input.all_day === 'boolean') patch.allDay = input.all_day;
  const startProvided = input.start !== undefined;
  const endProvided = input.end !== undefined;
  if (startProvided !== endProvided) {
    return {
      ok: false,
      reason: 'Hvis du ændrer tid, skal du sende både `start` OG `end`.',
    };
  }
  if (startProvided && endProvided) {
    const start = parseDate(input.start);
    const end = parseDate(input.end);
    if (!start || !end) return { ok: false, reason: 'Ugyldig dato/tid.' };
    if (end.getTime() <= start.getTime()) return { ok: false, reason: '`end` skal ligge efter `start`.' };
    patch.start = start;
    patch.end = end;
  }
  if (input.attendees !== undefined) {
    const arr = parseStringArray(input.attendees);
    if (arr) patch.attendees = arr;
  }
  return { ok: true, data: patch };
}

type MailComposeProvider = 'google' | 'microsoft' | 'icloud';

type MailComposeParsed = {
  provider: MailComposeProvider;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  replyToUnifiedId?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s));
}

function parseMailComposeInput(input: Record<string, unknown>): ParseResult<MailComposeParsed> {
  const provider = input.provider;
  if (provider !== 'google' && provider !== 'microsoft' && provider !== 'icloud') {
    return {
      ok: false,
      reason: '`provider` skal være "google", "microsoft" eller "icloud".',
    };
  }
  const to = parseEmailList(input.to);
  if (to.length === 0) {
    return { ok: false, reason: 'Mindst én gyldig modtager-mailadresse i `to` er påkrævet.' };
  }
  const ccRaw = input.cc;
  const cc = ccRaw === undefined ? undefined : parseEmailList(ccRaw);
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (!subject) return { ok: false, reason: 'Mangler `subject`.' };
  const body = typeof input.body === 'string' ? input.body : '';
  if (!body.trim()) return { ok: false, reason: 'Mangler `body`.' };
  const replyToUnifiedId =
    typeof input.reply_to_id === 'string' && input.reply_to_id.trim()
      ? input.reply_to_id.trim()
      : undefined;
  return {
    ok: true,
    data: { provider, to, cc, subject, body, replyToUnifiedId },
  };
}

// Splits "google:abc" → ['google', 'abc']. Returns null if the unified ID
// doesn't carry the provider prefix (i.e. the model passed a raw provider id).
function splitUnifiedId(unified: string): { provider: string; id: string } | null {
  const colon = unified.indexOf(':');
  if (colon <= 0) return null;
  return { provider: unified.slice(0, colon), id: unified.slice(colon + 1) };
}

// Record a successful send into the local sent-mails log without ever
// throwing back into the caller. The send already succeeded — a logging
// failure must not surface to the user as a send failure.
async function recordSentMailSafe(
  userId: string | null,
  input: RecordSentMailInput,
): Promise<void> {
  if (!userId) return;
  try {
    await recordSentMail(userId, input);
  } catch (e) {
    if (__DEV__) console.warn('[hooks] recordSentMail failed:', e);
  }
}

function mapIcloudComposeError(code: IcloudErrorCode): string {
  switch (code) {
    case 'auth-failed':
    case 'credential-rejected':
      return 'Apple afviste login. Din app-specific password er måske udløbet — opdater under Indstillinger.';
    case 'rate-limited':
      return 'For mange iCloud-mails sendt fra Zolva i dag. Prøv igen om en time.';
    case 'network':
    case 'timeout':
    case 'temporarily-unavailable':
    case 'gateway-unavailable':
      return 'iCloud kunne ikke nås. Prøv igen om lidt.';
    case 'not-connected':
      return 'Brugeren har ikke forbundet en iCloud-konto. Foreslå at forbinde iCloud under Indstillinger.';
    case 'unauthorized':
      return 'Bruger-session udløbet. Log ind igen.';
    case 'protocol':
    default:
      return 'iCloud afviste afsendelsen.';
  }
}

async function runMailComposeTool(
  name: 'create_draft' | 'send_mail',
  input: Record<string, unknown>,
  ctx: ChatCtx,
): Promise<{ text: string; isError: boolean }> {
  const parsed = parseMailComposeInput(input);
  if (!parsed.ok) return { text: parsed.reason, isError: true };
  const { provider, to, cc, subject, body, replyToUnifiedId } = parsed.data;

  if (provider === 'google' && !ctx.gmail) {
    return {
      text: 'Brugeren har ikke forbundet en Gmail-konto. Foreslå at forbinde Gmail under Indstillinger, eller brug "microsoft" hvis Outlook er forbundet.',
      isError: true,
    };
  }
  if (provider === 'microsoft' && !ctx.outlookMail) {
    return {
      text: 'Brugeren har ikke forbundet en Outlook-konto. Foreslå at forbinde Outlook under Indstillinger, eller brug "google" hvis Gmail er forbundet.',
      isError: true,
    };
  }
  if (provider === 'icloud' && !ctx.icloud) {
    return {
      text: 'Brugeren har ikke forbundet en iCloud-konto. Foreslå at forbinde iCloud under Indstillinger.',
      isError: true,
    };
  }

  // For replies, resolve the original message id from the unified id. We
  // also reject mismatched providers (e.g. provider=google with a microsoft:
  // unified id) so the user gets a clear error rather than a silent crash.
  let providerReplyId: string | undefined;
  if (replyToUnifiedId) {
    const split = splitUnifiedId(replyToUnifiedId);
    const replyProvider = split?.provider ?? provider;
    if (replyProvider !== provider) {
      return {
        text: `\`reply_to_id\` peger på ${replyProvider}, men provider er ${provider}. Brug samme provider som mailen blev modtaget på.`,
        isError: true,
      };
    }
    providerReplyId = split?.id ?? replyToUnifiedId;
  }

  let providerReplyIdNum: number | undefined;
  if (provider === 'icloud' && providerReplyId !== undefined) {
    const n = Number(providerReplyId);
    if (!Number.isFinite(n)) {
      return { text: 'Ugyldigt iCloud reply-ID.', isError: true };
    }
    providerReplyIdNum = n;
  }

  try {
    if (provider === 'google') {
      // For Gmail replies we need threading headers from the original message.
      // The /drafts and /messages/send endpoints take threadId + In-Reply-To/
      // References — without them Gmail starts a new conversation even when
      // we hit the right inbox.
      let threadHeaders: { threadId?: string; inReplyTo?: string; references?: string } = {};
      if (providerReplyId) {
        try {
          const original = await gmailGetMessageBody(providerReplyId);
          const refs = original.references
            ? `${original.references} ${original.messageIdHeader}`.trim()
            : original.messageIdHeader;
          threadHeaders = {
            threadId: original.threadId,
            inReplyTo: original.messageIdHeader || undefined,
            references: refs || undefined,
          };
        } catch (err) {
          if (__DEV__) console.warn('[hooks] gmail reply lookup failed:', err);
          // Fall through — we'll still create the message, just without
          // threading. Better than failing the whole call.
        }
      }

      if (name === 'create_draft') {
        const r = await gmailCreateDraft({ to, cc, subject, body, ...threadHeaders });
        return { text: `Udkast oprettet i Gmail (id: ${r.id || 'ukendt'}).`, isError: false };
      }
      await gmailSendMail({ to, cc, subject, body, ...threadHeaders });
      void recordSentMailSafe(ctx.userId, { provider: 'google', to, cc, subject, body, replyToId: replyToUnifiedId });
      // Mirror useSendReply's UX: replies dismiss the original from the
      // inbox so it exits "Venter på dig" and lands in "Læst".
      if (replyToUnifiedId) markMailReplied(replyToUnifiedId);
      return { text: 'Mailen er sendt fra Gmail.', isError: false };
    }

    if (provider === 'icloud') {
      if (!ctx.userId) {
        return { text: 'Ingen bruger-session.', isError: true };
      }
      if (name === 'create_draft') {
        const r = await icloudAppendDraft(ctx.userId, {
          to,
          cc,
          subject,
          body,
          replyToUid: providerReplyIdNum,
        });
        if (!r.ok) return { text: mapIcloudComposeError(r.error), isError: true };
        return { text: 'Udkast oprettet i iCloud.', isError: false };
      }
      const r = await icloudSendMail(ctx.userId, {
        to,
        cc,
        subject,
        body,
        replyToUid: providerReplyIdNum,
      });
      if (!r.ok) return { text: mapIcloudComposeError(r.error), isError: true };
      void recordSentMailSafe(ctx.userId, { provider: 'icloud', to, cc, subject, body, replyToId: replyToUnifiedId });
      if (replyToUnifiedId) markMailReplied(replyToUnifiedId);
      return {
        text: providerReplyIdNum
          ? 'Svaret er sendt fra iCloud.'
          : 'Mailen er sendt fra iCloud.',
        isError: false,
      };
    }

    // Microsoft
    if (name === 'create_draft') {
      const r = await graphCreateDraft({ to, cc, subject, body, replyToId: providerReplyId });
      return { text: `Udkast oprettet i Outlook (id: ${r.id || 'ukendt'}).`, isError: false };
    }
    if (providerReplyId) {
      // Use the existing reply endpoint for sends so threading is preserved
      // server-side. graphSendMail with replyToId routes here too, but going
      // direct keeps the call shorter.
      await graphReplyToMessage(providerReplyId, body);
      void recordSentMailSafe(ctx.userId, { provider: 'microsoft', to, cc, subject, body, replyToId: replyToUnifiedId });
      // Outlook's reply endpoint already archives server-side; the local
      // dismiss makes the disappear immediate (before the inbox re-fetches).
      if (replyToUnifiedId) markMailReplied(replyToUnifiedId);
      return { text: 'Svaret er sendt fra Outlook.', isError: false };
    }
    await graphSendMail({ to, cc, subject, body });
    void recordSentMailSafe(ctx.userId, { provider: 'microsoft', to, cc, subject, body, replyToId: replyToUnifiedId });
    return { text: 'Mailen er sendt fra Outlook.', isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Mail-værktøjet fejlede: ${msg}`, isError: true };
  }
}

async function runChatTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ChatCtx,
): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === 'list_calendars') {
      const r = await listCalendarsAcrossProviders(ctx);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'list_calendar_events') {
      const fromRaw = typeof input.from === 'string' ? input.from : '';
      const toRaw = typeof input.to === 'string' ? input.to : '';
      const from = new Date(fromRaw);
      const to = new Date(toRaw);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return { content: 'Ugyldige datoer. Brug ISO 8601 med tidszone-offset.', isError: true };
      }
      if (to.getTime() <= from.getTime()) {
        return { content: '`to` skal ligge efter `from`.', isError: true };
      }
      const r = await listCalendarEventsAcrossProviders(ctx, from, to);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'list_recent_mail') {
      const raw = typeof input.limit === 'number' ? input.limit : 10;
      const limit = Math.max(1, Math.min(Math.floor(raw), 30));
      const r = await listRecentMailAcrossProviders(ctx, limit);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'read_mail_thread') {
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) return { content: 'Mangler `id`.', isError: true };
      const r = await readMailBody(ctx, id);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'create_calendar_event') {
      const parsed = parseWriteInput(input);
      if (!parsed.ok) return { content: parsed.reason, isError: true };
      const provider = typeof input.provider === 'string' ? input.provider : '';
      if (!provider) return { content: '`provider` mangler. Brug "microsoft" eller "icloud".', isError: true };
      const r = await createCalendarEvent(ctx, provider, parsed.data);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'update_calendar_event') {
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) return { content: 'Mangler `id`.', isError: true };
      const patch = parseWritePatch(input);
      if (!patch.ok) return { content: patch.reason, isError: true };
      const r = await updateCalendarEvent(ctx, id, patch.data);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'delete_calendar_event') {
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) return { content: 'Mangler `id`.', isError: true };
      const r = await deleteCalendarEvent(ctx, id);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'search_drive_files') {
      const query = typeof input.query === 'string' ? input.query : '';
      const rawLimit = typeof input.limit === 'number' ? input.limit : 10;
      const limit = Math.max(1, Math.min(Math.floor(rawLimit), 25));
      const r = await searchDriveFilesTool(ctx, query, limit);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'create_draft' || name === 'send_mail') {
      const r = await runMailComposeTool(name, input, ctx);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'read_drive_file') {
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) return { content: 'Mangler `id`.', isError: true };
      const r = await readDriveFile(ctx, id);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'search_onedrive_files') {
      const query = typeof input.query === 'string' ? input.query : '';
      const rawLimit = typeof input.limit === 'number' ? input.limit : 10;
      const limit = Math.max(1, Math.min(Math.floor(rawLimit), 25));
      const r = await searchOnedriveFilesTool(ctx, query, limit);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'read_onedrive_file') {
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) return { content: 'Mangler `id`.', isError: true };
      const r = await readOnedriveFile(ctx, id);
      return { content: r.text, isError: r.isError };
    }
    if (name === 'add_reminder') {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim()) return { content: 'Manglede tekst.', isError: true };
      const dueRaw = typeof input.due_at === 'string' ? input.due_at : undefined;
      const due = dueRaw ? new Date(dueRaw) : null;
      const dueClean = due && !Number.isNaN(due.getTime()) ? due : null;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const userId = ctx.userId;
      if (!userId) return { content: 'Ikke logget ind.', isError: true };
      const r = await addReminder(userId, text, dueClean, tz);
      return { content: `Oprettet påmindelse ${r.id}: "${r.text}"${r.dueAt ? ` til ${r.dueAt.toISOString()}` : ''}.`, isError: false };
    }
    if (name === 'add_note') {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim()) return { content: 'Manglede tekst.', isError: true };
      const n = await storeAddNote(text);
      return { content: `Oprettet note ${n.id}: "${n.text}".`, isError: false };
    }
    if (name === 'list_reminders') {
      const userId = ctx.userId;
      if (!userId) return { content: 'Ikke logget ind.', isError: true };
      const all = await listAllReminders(userId);
      const now = new Date();
      const rs = all.filter((r) => isPendingAndDueOrUpcoming(r, now));
      if (rs.length === 0) return { content: 'Ingen påmindelser gemt.', isError: false };
      return { content: rs.map(formatReminderForListTool).join('\n'), isError: false };
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

// Bumped from 2 to 5 so the model can chain calendar/mail tools (e.g. list
// events → read a specific mail thread referenced in an event description →
// answer). Each round is one Anthropic call; 5 is comfortably under any
// real-world need without giving the model room to runaway-loop.
const CHAT_TOOL_ROUND_CAP = 5;

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
  const { user, googleAccessToken, microsoftAccessToken } = useAuth();
  const demo = isDemoUser(user);
  const demoIndexRef = useRef(0);
  // Sync guard against double-fire from spam taps. setTyping(true) is React
  // state and won't reflect until the next render — two chip taps in the
  // same frame both see typing=false and both fire a turn. The ref flips
  // immediately so the second send aborts before any work happens.
  const inFlightRef = useRef(false);
  const name = profile?.name ?? '';
  const userId = user?.id;
  const icloudConnected = useIcloudConnected(userId ?? '');
  // Don't capture isEnabled from the hook — that snapshot is closed into
  // `send` and goes stale if the user toggles after the callback was built.
  // We read the live module cache via isIntegrationEffectivelyEnabled below.

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
      // Sync re-entry guard — see inFlightRef declaration above. Gate fires
      // before any state mutation so a duplicate tap is a complete no-op,
      // not a half-applied user-message-without-response.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        from: 'user',
        text: trimmed,
        createdAt: new Date().toISOString(),
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
            { id: `a-${Date.now()}`, from: 'zolva', text: reply, createdAt: new Date().toISOString() },
          ]);
          setTyping(false);
          inFlightRef.current = false;
        }, 900);
        return;
      }

      if (userId) syncChatMessage(userId, userMsg);

      const metadata =
        getPrivacyFlag('training-opt-in') && userId ? { user_id: userId } : undefined;

      const runTurn = async (): Promise<string> => {
        const hasGoogle = !!googleAccessToken;
        const hasMicrosoft = !!microsoftAccessToken;
        // Read the live flag cache, not a closure snapshot, so toggles made
        // mid-conversation take effect on the very next turn.
        const toolCtx: ChatCtx = {
          userId: userId ?? null,
          gmail: isIntegrationEffectivelyEnabled('gmail', hasGoogle),
          googleCalendar: isIntegrationEffectivelyEnabled('google-calendar', hasGoogle),
          googleDrive: isIntegrationEffectivelyEnabled('google-drive', hasGoogle),
          outlookMail: isIntegrationEffectivelyEnabled('outlook-mail', hasMicrosoft),
          outlookCalendar: isIntegrationEffectivelyEnabled('outlook-calendar', hasMicrosoft),
          onedrive: isIntegrationEffectivelyEnabled('onedrive', hasMicrosoft),
          icloud: isIntegrationEffectivelyEnabled('icloud', icloudConnected),
        };
        const working: ClaudeMessage[] = toClaudeMessages(nextHistory, toolCtx);
        let correctionAttempted = false;

        for (let round = 0; round < CHAT_TOOL_ROUND_CAP; round += 1) {
          const result = await completeRaw({
            system: buildChatSystemPrompt(name, toolCtx),
            messages: working,
            tools: filterToolsByCtx(CHAT_TOOLS, toolCtx),
            metadata,
          });

          if (result.toolUses.length > 0) {
            working.push({ role: 'assistant', content: result.rawContent });
            const toolResults = await Promise.all(
              result.toolUses.map(async (t) => {
                const r = await runChatTool(t.name, t.input, toolCtx);
                return {
                  type: 'tool_result' as const,
                  tool_use_id: t.id,
                  content: r.content,
                  is_error: r.isError,
                };
              }),
            );
            working.push({ role: 'user', content: toolResults });
            continue;
          }

          const text = result.text.trim();
          const toolUsedThisTurn = working.some(
            (m) =>
              m.role === 'assistant' &&
              Array.isArray(m.content) &&
              m.content.some((b) => b.type === 'tool_use'),
          );

          if (toolUsedThisTurn) {
            // Final summary after a real tool call — grounded by tool_result.
            return text;
          }

          const claim = await classifyClaim(text);
          if (!claim.claimed) {
            return text;
          }

          if (correctionAttempted) {
            if (__DEV__ && getPrivacyFlag('anon-reports')) {
              console.warn(`${CHAT_GUARD_DEBUG_TAG} correction failed, falling back`);
            }
            return GENERIC_CONFUSED_FALLBACK;
          }

          if (__DEV__ && getPrivacyFlag('anon-reports')) {
            console.warn(
              `${CHAT_GUARD_DEBUG_TAG} caught ${claim.tool ?? 'unknown'}: "${text.slice(0, 80)}"`,
            );
          }

          correctionAttempted = true;
          working.push({ role: 'assistant', content: result.rawContent });
          working.push({ role: 'user', content: buildCorrectionMessage(claim.tool) });
        }

        return GENERIC_CONFUSED_FALLBACK;
      };

      runTurn()
        .then((answer) => {
          const assistantMsg: ChatMessage = {
            id: `a-${Date.now()}`,
            from: 'zolva',
            text: answer.length > 0 ? answer : CHAT_ERROR_TEXT,
            createdAt: new Date().toISOString(),
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
            { id: `e-${Date.now()}`, from: 'zolva', text: CHAT_ERROR_TEXT, createdAt: new Date().toISOString() },
          ]);
        })
        .finally(() => {
          setTyping(false);
          inFlightRef.current = false;
        });
    },
    [messages, name, userId, demo, googleAccessToken, microsoftAccessToken],
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

export function useMemoryEnabled(): boolean {
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

// ─── Onboarding backfill state ─────────────────────────────────────────────

const onboardingBackfillKey = (uid: string) => `zolva.${uid}.onboarding-backfill.shown`;

export async function shouldShowOnboardingBackfill(uid: string): Promise<boolean> {
  if (!getPrivacyFlag('memory-enabled')) return false;
  try {
    const raw = await AsyncStorage.getItem(onboardingBackfillKey(uid));
    return raw !== '1';
  } catch {
    return false;
  }
}

export async function markOnboardingBackfillShown(uid: string): Promise<void> {
  try {
    await AsyncStorage.setItem(onboardingBackfillKey(uid), '1');
  } catch {}
}

// ─── What's-new modal helpers ──────────────────────────────────────────────
//
// One-shot per-user modal shown after an OTA with notable user-visible
// changes. Keyed by version so bumping WHATS_NEW_VERSION re-triggers for
// users who already saw the prior version's modal.

const whatsNewKey = (uid: string, version: string) =>
  `zolva.${uid}.whatsnew.shown.${version}`;

export async function shouldShowWhatsNew(uid: string, version: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(whatsNewKey(uid, version));
    return !raw;
  } catch {
    return false;
  }
}

export async function markWhatsNewShown(uid: string, version: string): Promise<void> {
  try {
    await AsyncStorage.setItem(whatsNewKey(uid, version), Date.now().toString());
  } catch {}
}

// ─── Microsoft scope-bump reconnect prompt ─────────────────────────────────
// One-shot nudge tied to the Calendars.Read → Calendars.ReadWrite scope
// bump. Old tokens still carry Calendars.Read, so calendar writes 403 until
// the user re-consents. Key is per-uid so a fresh sign-in on the same device
// still gets the prompt once.

const msReconnectPromptKey = (uid: string) =>
  `zolva.${uid}.prompts.ms-calendar-rw.v1`;

export async function shouldShowMsReconnectPrompt(uid: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(msReconnectPromptKey(uid));
    return !raw;
  } catch {
    return true;
  }
}

export async function markMsReconnectPromptShown(uid: string): Promise<void> {
  try {
    await AsyncStorage.setItem(msReconnectPromptKey(uid), Date.now().toString());
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
    // Reset the onboarding-backfill shown flag whenever memory is turned off,
    // so toggling memory off → on re-triggers the chain. Without this, a user
    // who dismissed the intro before connecting providers is permanently
    // locked out of the onboarding flow.
    if (id === 'memory-enabled' && value === false) {
      try {
        await AsyncStorage.removeItem(`zolva.${uid}.onboarding-backfill.shown`);
      } catch {}
    }
  }
  notifyPrivacyChange();
}

// TODO(v3): Replace local refresh with Supabase realtime subscription on
// user_profiles when we add multi-device support (Mac / Watch / Web).
// For v2 the user is the only writer from one device, so refresh-on-mount
// + refresh-after-write is sufficient.
export function useCalendarLabels() {
  const { user } = useAuth();
  const [labels, setLabels] = useState<CalendarLabels>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user?.id) {
      setLabels({});
      setLoading(false);
      return;
    }
    try {
      const fresh = await readCalendarLabels(user.id);
      setLabels(fresh);
    } catch (err) {
      if (__DEV__) console.warn('[useCalendarLabels] refresh failed:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to label-bus notifications so external writers (provider
  // disconnect auto-clear in auth.ts / icloud-credentials.ts) trigger a
  // refresh — without this, Stemmestyring keeps rendering a calendar the
  // user just disconnected.
  useEffect(() => {
    return subscribeCalendarLabelsChanged(() => {
      void refresh();
    });
  }, [refresh]);

  const setLabel = useCallback(
    async (key: CalendarLabelKey, target: CalendarLabelTarget | null) => {
      if (!user?.id) return;
      await setCalendarLabel(user.id, key, target);
      // setCalendarLabel notifies the bus, which fires our subscription and
      // refreshes — no explicit refresh() needed here.
    },
    [user?.id],
  );

  return { labels, loading, refresh, setLabel };
}
