// Persistent store for reminders and notes. Written to AsyncStorage so
// entries survive app restart. Hooks (useReminders, useNotes) subscribe
// to the listener sets here. Chat tool handlers mutate via the exported
// add*/remove* functions so Zolva can genuinely remember things.
//
// Storage is scoped to the active Supabase user id. Signing in as a
// different user swaps the in-memory cache and rehydrates from that
// user's keys — previous user's reminders and notes never leak.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeUserId } from './auth';
import type { Note, NoteCategory, Reminder, ReminderStatus } from './types';
import {
  cancelReminderNotification,
  scheduleReminderNotification,
} from './notifications';
import { recordFeedEntry } from './notification-feed';

const remindersKey = (uid: string) => `zolva.${uid}.memory.reminders`;
const notesKey = (uid: string) => `zolva.${uid}.memory.notes`;

let currentUid: string | null = null;
let remindersCache: Reminder[] = [];
let notesCache: Note[] = [];
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

const remindersListeners = new Set<(r: Reminder[]) => void>();
const notesListeners = new Set<(n: Note[]) => void>();

function notifyReminders() {
  const snapshot = remindersCache;
  remindersListeners.forEach((l) => l(snapshot));
}
function notifyNotes() {
  const snapshot = notesCache;
  notesListeners.forEach((l) => l(snapshot));
}

function reviveReminder(raw: unknown): Reminder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Reminder> & { dueAt?: string | Date; createdAt?: string | Date };
  if (typeof r.id !== 'string' || typeof r.text !== 'string') return null;
  const dueAt = r.dueAt instanceof Date ? r.dueAt : new Date(r.dueAt ?? Date.now());
  const createdAt = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt ?? Date.now());
  const status: ReminderStatus = r.status === 'done' ? 'done' : 'pending';
  return { id: r.id, text: r.text, dueAt, createdAt, status };
}

function reviveNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Partial<Note> & { createdAt?: string | Date };
  if (typeof n.id !== 'string' || typeof n.text !== 'string') return null;
  const createdAt = n.createdAt instanceof Date ? n.createdAt : new Date(n.createdAt ?? Date.now());
  const categories: NoteCategory[] = ['task', 'idea', 'note', 'info'];
  const category: NoteCategory = categories.includes(n.category as NoteCategory)
    ? (n.category as NoteCategory)
    : 'note';
  return { id: n.id, text: n.text, category, createdAt };
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
      const [[, remindersRaw], [, notesRaw]] = await AsyncStorage.multiGet([
        remindersKey(uid),
        notesKey(uid),
      ]);
      // Bail if the active user changed during the read — the effect for
      // the new user will run its own hydrate.
      if (uid !== currentUid) return;
      if (remindersRaw) {
        const parsed = JSON.parse(remindersRaw) as unknown;
        if (Array.isArray(parsed)) {
          remindersCache = parsed.map(reviveReminder).filter((r): r is Reminder => r !== null);
        }
      }
      if (notesRaw) {
        const parsed = JSON.parse(notesRaw) as unknown;
        if (Array.isArray(parsed)) {
          notesCache = parsed.map(reviveNote).filter((n): n is Note => n !== null);
        }
      }
    } catch (err) {
      if (__DEV__) console.warn('[memory-store] hydrate failed:', err);
    }
    if (uid === currentUid) {
      hydrated = true;
      notifyReminders();
      notifyNotes();
    }
  })().finally(() => {
    hydrationPromise = null;
  });
  return hydrationPromise;
}

let userSubscribed = false;
function ensureUserSubscription() {
  if (userSubscribed) return;
  userSubscribed = true;
  subscribeUserId((uid) => {
    if (uid === currentUid) return;
    currentUid = uid;
    remindersCache = [];
    notesCache = [];
    hydrated = false;
    hydrationPromise = null;
    notifyReminders();
    notifyNotes();
    if (uid) void hydrate();
  });
}

async function persistReminders() {
  if (!currentUid) return;
  try {
    await AsyncStorage.setItem(remindersKey(currentUid), JSON.stringify(remindersCache));
  } catch (err) {
    if (__DEV__) console.warn('[memory-store] persist reminders failed:', err);
  }
}

async function persistNotes() {
  if (!currentUid) return;
  try {
    await AsyncStorage.setItem(notesKey(currentUid), JSON.stringify(notesCache));
  } catch (err) {
    if (__DEV__) console.warn('[memory-store] persist notes failed:', err);
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function initMemoryStore(): void {
  ensureUserSubscription();
  void hydrate();
}

export function subscribeReminders(listener: (r: Reminder[]) => void): () => void {
  ensureUserSubscription();
  remindersListeners.add(listener);
  void hydrate();
  listener(remindersCache);
  return () => {
    remindersListeners.delete(listener);
  };
}

export function subscribeNotes(listener: (n: Note[]) => void): () => void {
  ensureUserSubscription();
  notesListeners.add(listener);
  void hydrate();
  listener(notesCache);
  return () => {
    notesListeners.delete(listener);
  };
}

export function listReminders(): Reminder[] {
  return remindersCache;
}

export function listNotes(): Note[] {
  return notesCache;
}

export async function addReminder(text: string, dueAt?: Date | null): Promise<Reminder> {
  ensureUserSubscription();
  await hydrate();
  if (!currentUid) throw new Error('No active user — sign in before storing reminders.');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Reminder text is required');
  const reminder: Reminder = {
    id: genId('r'),
    text: trimmed,
    dueAt: dueAt ?? null,
    createdAt: new Date(),
    status: 'pending',
  };
  remindersCache = [...remindersCache, reminder];
  notifyReminders();
  await persistReminders();
  void scheduleReminderNotification(reminder);
  void recordFeedEntry({
    id: `reminderAdded:${reminder.id}`,
    type: 'reminderAdded',
    title: 'Påmindelse tilføjet',
    body: reminder.text,
    firesAt: reminder.createdAt,
    createdAt: reminder.createdAt,
    payload: { type: 'reminderAdded', reminderId: reminder.id },
  });
  return reminder;
}

export async function markReminderDone(id: string): Promise<void> {
  ensureUserSubscription();
  await hydrate();
  remindersCache = remindersCache.map((r) => (r.id === id ? { ...r, status: 'done' } : r));
  notifyReminders();
  await persistReminders();
  void cancelReminderNotification(id);
}

export async function removeReminder(id: string): Promise<void> {
  ensureUserSubscription();
  await hydrate();
  remindersCache = remindersCache.filter((r) => r.id !== id);
  notifyReminders();
  await persistReminders();
  void cancelReminderNotification(id);
}

export async function addNote(text: string, category: NoteCategory = 'note'): Promise<Note> {
  ensureUserSubscription();
  await hydrate();
  if (!currentUid) throw new Error('No active user — sign in before storing notes.');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Note text is required');
  const note: Note = {
    id: genId('n'),
    text: trimmed,
    category,
    createdAt: new Date(),
  };
  notesCache = [...notesCache, note];
  notifyNotes();
  await persistNotes();
  return note;
}

export async function removeNote(id: string): Promise<void> {
  ensureUserSubscription();
  await hydrate();
  notesCache = notesCache.filter((n) => n.id !== id);
  notifyNotes();
  await persistNotes();
}
