// src/lib/sent-mails.ts
//
// Local AsyncStorage-backed log of mails Zolva sent on the user's behalf.
// Provider-agnostic - Gmail, Outlook, and iCloud all funnel through the
// same recordSentMail() entry point so the user has one place to verify
// "did Zolva actually send this?".
//
// Why this exists: iCloud-sent mail does not land in Apple Mail's Sent
// folder (see 2026-05-06-icloud-send-mail-design.md non-goals - the IMAP
// APPEND is too slow for Supabase's 12s gateway). Gmail/Outlook DO
// populate their own Sent folders, but the user still benefits from a
// single in-app view since they may not check the provider's Sent
// folder right away. One mental model > three.
//
// Storage: per-user, capped at 200 most-recent sends to keep AsyncStorage
// reads cheap. Older entries fall off silently.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEMO_USER_ID, demoSentMailRecords, isDemoUserId, onDemoReset } from './demo-data';

export type SentMailProvider = 'google' | 'microsoft' | 'icloud';

export type SentMailRecord = {
  id: string;
  sentAt: string;     // ISO 8601
  provider: SentMailProvider;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;       // raw user-typed body - signature NOT included
  replyToId?: string; // unified ID of the original mail when this is a reply
};

const STORAGE_KEY = (userId: string) => `zolva.sent-mails.v1.${userId}`;
const MAX_ENTRIES = 200;

const cache = new Map<string, SentMailRecord[]>();
const subscribers = new Set<(userId: string) => void>();
let hydratedFor: string | null = null;
let hydrationPromise: Promise<void> | null = null;

// Nyt demo-login = frisk seedet log.
onDemoReset(() => {
  cache.set(DEMO_USER_ID, demoSentMailRecords());
  notify(DEMO_USER_ID);
});

async function hydrate(userId: string): Promise<void> {
  if (hydratedFor === userId && hydrationPromise) return hydrationPromise;
  if (hydratedFor !== userId) {
    cache.clear();
    hydratedFor = userId;
  }
  if (isDemoUserId(userId)) {
    // Demo: seedet log, kun i hukommelsen (persist springes over nedenfor).
    if (!cache.has(userId)) cache.set(userId, demoSentMailRecords());
    hydrationPromise = Promise.resolve();
    return hydrationPromise;
  }
  hydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY(userId));
      if (!raw) {
        cache.set(userId, []);
        return;
      }
      const parsed = JSON.parse(raw) as SentMailRecord[];
      cache.set(userId, Array.isArray(parsed) ? parsed : []);
    } catch (e) {
      if (__DEV__) console.warn('[sent-mails] hydrate failed:', e);
      cache.set(userId, []);
    }
  })();
  return hydrationPromise;
}

function notify(userId: string): void {
  for (const cb of subscribers) {
    try { cb(userId); } catch { /* ignore */ }
  }
}

async function persist(userId: string): Promise<void> {
  if (isDemoUserId(userId)) return;
  const list = cache.get(userId) ?? [];
  try {
    await AsyncStorage.setItem(STORAGE_KEY(userId), JSON.stringify(list));
  } catch (e) {
    if (__DEV__) console.warn('[sent-mails] persist failed:', e);
  }
}

export type RecordSentMailInput = {
  provider: SentMailProvider;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  replyToId?: string;
};

export async function recordSentMail(
  userId: string,
  input: RecordSentMailInput,
): Promise<SentMailRecord> {
  if (!userId) {
    // Defensive - shouldn't happen given the gate in callers, but a
    // missing userId should not crash a successful send.
    throw new Error('recordSentMail: missing userId');
  }
  await hydrate(userId);
  const record: SentMailRecord = {
    id: `sm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sentAt: new Date().toISOString(),
    provider: input.provider,
    to: input.to,
    cc: input.cc && input.cc.length > 0 ? input.cc : undefined,
    subject: input.subject,
    body: input.body,
    replyToId: input.replyToId,
  };
  const next = [record, ...(cache.get(userId) ?? [])].slice(0, MAX_ENTRIES);
  cache.set(userId, next);
  // Persist async; don't block the caller - the in-memory cache is the
  // source of truth for the current session.
  void persist(userId);
  notify(userId);
  return record;
}

export async function listSentMails(userId: string): Promise<SentMailRecord[]> {
  if (!userId) return [];
  await hydrate(userId);
  return [...(cache.get(userId) ?? [])];
}

export async function clearSentMails(userId: string): Promise<void> {
  if (!userId) return;
  cache.set(userId, []);
  if (isDemoUserId(userId)) {
    notify(userId);
    return;
  }
  try {
    await AsyncStorage.removeItem(STORAGE_KEY(userId));
  } catch (e) {
    if (__DEV__) console.warn('[sent-mails] clear failed:', e);
  }
  notify(userId);
}

// Subscribe for live updates. Callback fires on every record/clear, with
// the userId that changed. Returns an unsubscribe function.
export function subscribeSentMails(cb: (userId: string) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
