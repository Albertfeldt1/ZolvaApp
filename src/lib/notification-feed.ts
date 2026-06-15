// In-app notification feed. Records entries as notifications are scheduled
// (and when reminders are added), exposes them for NotificationsScreen, and
// tracks per-entry read state. Scoped to the active Supabase user id so
// account switches don't leak across sessions.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeUserId } from './auth';
import { isFeedEntryType, type FeedEntry, type FeedEntryType, type NotificationPayload } from './types';

const feedKey = (uid: string) => `zolva.${uid}.notifications.feed`;

const ENTRY_CAP = 100;
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

let currentUid: string | null = null;
let cache: FeedEntry[] = [];
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

const listeners = new Set<(entries: FeedEntry[]) => void>();

function notify() {
  const snapshot = cache;
  listeners.forEach((l) => l(snapshot));
}

function reviveEntry(raw: unknown): FeedEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<FeedEntry> & {
    firesAt?: string | Date;
    createdAt?: string | Date;
    readAt?: string | Date | null;
  };
  if (typeof e.id !== 'string' || typeof e.title !== 'string') return null;
  // Validate against the single source of truth so newer types (chatReply,
  // agent_proposal, trialEnding) survive a reload instead of being dropped.
  if (!isFeedEntryType(e.type)) return null;
  const firesAt = e.firesAt instanceof Date ? e.firesAt : new Date(e.firesAt ?? Date.now());
  const createdAt = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt ?? Date.now());
  const readAt =
    e.readAt == null
      ? null
      : e.readAt instanceof Date
        ? e.readAt
        : new Date(e.readAt);
  const payload = e.payload as NotificationPayload | undefined;
  if (!payload || typeof payload !== 'object' || !('type' in payload)) return null;
  return {
    id: e.id,
    type: e.type as FeedEntryType,
    title: e.title,
    body: typeof e.body === 'string' ? e.body : undefined,
    firesAt,
    createdAt,
    readAt,
    payload,
  };
}

function dropExpiredAndCap(entries: FeedEntry[]): FeedEntry[] {
  const cutoff = Date.now() - EXPIRY_MS;
  const fresh = entries.filter((e) => e.createdAt.getTime() >= cutoff);
  if (fresh.length <= ENTRY_CAP) return fresh;
  // Keep newest ENTRY_CAP by createdAt
  return [...fresh].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, ENTRY_CAP);
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (hydrationPromise) return hydrationPromise;
  const uid = currentUid;
  if (!uid) {
    hydrated = true;
    return;
  }
  hydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(feedKey(uid));
      if (uid !== currentUid) return;
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const revived = parsed.map(reviveEntry).filter((e): e is FeedEntry => e !== null);
          cache = dropExpiredAndCap(revived);
        }
      }
    } catch (err) {
      if (__DEV__) console.warn('[notification-feed] hydrate failed:', err);
    }
    if (uid === currentUid) {
      hydrated = true;
      notify();
    }
  })().finally(() => {
    hydrationPromise = null;
  });
  return hydrationPromise;
}

async function persist(): Promise<void> {
  if (!currentUid) return;
  try {
    await AsyncStorage.setItem(feedKey(currentUid), JSON.stringify(cache));
  } catch (err) {
    if (__DEV__) console.warn('[notification-feed] persist failed:', err);
  }
}

let userSubscribed = false;
function ensureUserSubscription() {
  if (userSubscribed) return;
  userSubscribed = true;
  subscribeUserId((uid) => {
    if (uid === currentUid) return;
    currentUid = uid;
    cache = [];
    hydrated = false;
    hydrationPromise = null;
    notify();
    if (uid) void hydrate();
  });
}

export function initNotificationFeed(): void {
  ensureUserSubscription();
  void hydrate();
}

export function listFeedEntries(): FeedEntry[] {
  return cache;
}

export function subscribeFeed(listener: (entries: FeedEntry[]) => void): () => void {
  ensureUserSubscription();
  listeners.add(listener);
  void hydrate();
  listener(cache);
  return () => {
    listeners.delete(listener);
  };
}

// Validate an arbitrary notification `data` blob into a typed payload, or null
// if it isn't a recognised notification. Used to turn delivered push/local
// notifications into feed entries.
export function coerceNotificationPayload(data: unknown): NotificationPayload | null {
  if (!data || typeof data !== 'object') return null;
  const p = data as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] ? (p[k] as string) : null);
  switch (p.type) {
    case 'reminder': {
      const reminderId = str('reminderId');
      return reminderId ? { type: 'reminder', reminderId } : null;
    }
    case 'reminderAdded': {
      const reminderId = str('reminderId');
      return reminderId ? { type: 'reminderAdded', reminderId } : null;
    }
    case 'digest': {
      const date = str('date');
      return date ? { type: 'digest', date } : null;
    }
    case 'calendarPreAlert': {
      const eventId = str('eventId');
      return eventId ? { type: 'calendarPreAlert', eventId } : null;
    }
    case 'newMail': {
      const provider = p.provider;
      const messageId = str('messageId');
      if ((provider !== 'google' && provider !== 'microsoft') || !messageId) return null;
      return { type: 'newMail', provider, messageId, threadId: str('threadId') ?? undefined };
    }
    case 'brief': {
      const briefId = str('briefId');
      return briefId ? { type: 'brief', briefId } : null;
    }
    case 'factDecay': {
      const factId = str('factId');
      return factId ? { type: 'factDecay', factId } : null;
    }
    case 'microsoftConsentGranted': {
      const tenantDomain = str('tenantDomain');
      return tenantDomain ? { type: 'microsoftConsentGranted', tenantDomain } : null;
    }
    case 'chatReply': {
      const jobId = str('jobId');
      return jobId ? { type: 'chatReply', jobId } : null;
    }
    case 'agent_proposal': {
      const action_id = str('action_id');
      return action_id ? { type: 'agent_proposal', action_id } : null;
    }
    case 'trialEnding':
      return { type: 'trialEnding' };
    default:
      return null;
  }
}

// Deterministic, type-scoped feed id so a notification recorded both when it
// arrives (received listener) and when it's tapped (response listener)
// collapses to a single entry.
export function feedIdFor(payload: NotificationPayload): string {
  switch (payload.type) {
    case 'reminder': return `reminder:${payload.reminderId}`;
    case 'reminderAdded': return `reminderAdded:${payload.reminderId}`;
    case 'digest': return `digest:${payload.date}`;
    case 'calendarPreAlert': return `calendarPreAlert:${payload.eventId}`;
    case 'newMail': return `newMail:${payload.provider}:${payload.messageId}`;
    case 'brief': return `brief:${payload.briefId}`;
    case 'factDecay': return `factDecay:${payload.factId}`;
    case 'microsoftConsentGranted': return `microsoftConsentGranted:${payload.tenantDomain}`;
    case 'chatReply': return `chatReply:${payload.jobId}`;
    case 'agent_proposal': return `agent_proposal:${payload.action_id}`;
    case 'trialEnding': return 'trialEnding';
  }
}

// Build + record a feed entry from a delivered notification. Idempotent via
// feedIdFor, so receive + tap (and re-delivery) don't duplicate.
export async function recordFeedFromNotification(input: {
  payload: NotificationPayload;
  title: string;
  body?: string;
  firesAt?: Date;
}): Promise<void> {
  await recordFeedEntry({
    id: feedIdFor(input.payload),
    type: input.payload.type,
    title: input.title,
    body: input.body,
    firesAt: input.firesAt ?? new Date(),
    payload: input.payload,
  });
}

type RecordInput = Omit<FeedEntry, 'createdAt' | 'readAt'> & {
  createdAt?: Date;
};

// Idempotent: if an entry with the same id exists, skip. Callers build
// deterministic ids so reconciliation passes don't re-record.
export async function recordFeedEntry(input: RecordInput): Promise<void> {
  ensureUserSubscription();
  await hydrate();
  if (!currentUid) return;
  if (cache.some((e) => e.id === input.id)) return;

  const entry: FeedEntry = {
    id: input.id,
    type: input.type,
    title: input.title,
    body: input.body,
    firesAt: input.firesAt,
    createdAt: input.createdAt ?? new Date(),
    readAt: null,
    payload: input.payload,
  };
  cache = dropExpiredAndCap([entry, ...cache]);
  notify();
  await persist();
}

export async function markFeedEntryRead(id: string): Promise<void> {
  ensureUserSubscription();
  await hydrate();
  let changed = false;
  cache = cache.map((e) => {
    if (e.id !== id || e.readAt) return e;
    changed = true;
    return { ...e, readAt: new Date() };
  });
  if (!changed) return;
  notify();
  await persist();
}

export async function markAllFeedRead(): Promise<void> {
  ensureUserSubscription();
  await hydrate();
  const now = new Date();
  let changed = false;
  cache = cache.map((e) => {
    if (e.readAt) return e;
    changed = true;
    return { ...e, readAt: now };
  });
  if (!changed) return;
  notify();
  await persist();
}

// Called from App.tsx when the OS delivers a tapped notification, so the
// matching feed entry is marked read without the user having to open the
// feed and tap it a second time.
export async function markFeedByPayload(payload: NotificationPayload): Promise<void> {
  ensureUserSubscription();
  await hydrate();
  const now = new Date();
  let changed = false;
  cache = cache.map((e) => {
    if (e.readAt) return e;
    if (!payloadMatches(e.payload, payload)) return e;
    changed = true;
    return { ...e, readAt: now };
  });
  if (!changed) return;
  notify();
  await persist();
}

function payloadMatches(a: NotificationPayload, b: NotificationPayload): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'reminder' && b.type === 'reminder') return a.reminderId === b.reminderId;
  if (a.type === 'digest' && b.type === 'digest') return a.date === b.date;
  if (a.type === 'calendarPreAlert' && b.type === 'calendarPreAlert') return a.eventId === b.eventId;
  if (a.type === 'reminderAdded' && b.type === 'reminderAdded') return a.reminderId === b.reminderId;
  if (a.type === 'newMail' && b.type === 'newMail') {
    return a.provider === b.provider && a.messageId === b.messageId;
  }
  if (a.type === 'brief' && b.type === 'brief') return a.briefId === b.briefId;
  if (a.type === 'factDecay' && b.type === 'factDecay') return a.factId === b.factId;
  if (a.type === 'microsoftConsentGranted' && b.type === 'microsoftConsentGranted') {
    return a.tenantDomain === b.tenantDomain;
  }
  if (a.type === 'chatReply' && b.type === 'chatReply') return a.jobId === b.jobId;
  if (a.type === 'agent_proposal' && b.type === 'agent_proposal') return a.action_id === b.action_id;
  // trialEnding carries no id — type match (handled above) is enough.
  if (a.type === 'trialEnding' && b.type === 'trialEnding') return true;
  return false;
}
