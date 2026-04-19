// Persistent store for reminders and notes. Written to AsyncStorage so
// entries survive app restart. Hooks (useReminders, useNotes) subscribe
// to the listener sets here. Chat tool handlers mutate via the exported
// add*/remove* functions so Zolva can genuinely remember things.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Note, NoteCategory, Reminder, ReminderStatus } from './types';

const REMINDERS_KEY = 'zolva.memory.reminders';
const NOTES_KEY = 'zolva.memory.notes';

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
  hydrationPromise = (async () => {
    try {
      const [[, remindersRaw], [, notesRaw]] = await AsyncStorage.multiGet([
        REMINDERS_KEY,
        NOTES_KEY,
      ]);
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
    hydrated = true;
    notifyReminders();
    notifyNotes();
  })();
  return hydrationPromise;
}

async function persistReminders() {
  try {
    await AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(remindersCache));
  } catch (err) {
    if (__DEV__) console.warn('[memory-store] persist reminders failed:', err);
  }
}

async function persistNotes() {
  try {
    await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(notesCache));
  } catch (err) {
    if (__DEV__) console.warn('[memory-store] persist notes failed:', err);
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function initMemoryStore(): void {
  void hydrate();
}

export function subscribeReminders(listener: (r: Reminder[]) => void): () => void {
  remindersListeners.add(listener);
  void hydrate();
  listener(remindersCache);
  return () => {
    remindersListeners.delete(listener);
  };
}

export function subscribeNotes(listener: (n: Note[]) => void): () => void {
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

export async function addReminder(text: string, dueAt?: Date): Promise<Reminder> {
  await hydrate();
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Reminder text is required');
  const reminder: Reminder = {
    id: genId('r'),
    text: trimmed,
    dueAt: dueAt ?? new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    status: 'pending',
  };
  remindersCache = [...remindersCache, reminder];
  notifyReminders();
  await persistReminders();
  return reminder;
}

export async function markReminderDone(id: string): Promise<void> {
  await hydrate();
  remindersCache = remindersCache.map((r) => (r.id === id ? { ...r, status: 'done' } : r));
  notifyReminders();
  await persistReminders();
}

export async function removeReminder(id: string): Promise<void> {
  await hydrate();
  remindersCache = remindersCache.filter((r) => r.id !== id);
  notifyReminders();
  await persistReminders();
}

export async function addNote(text: string, category: NoteCategory = 'note'): Promise<Note> {
  await hydrate();
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
  await hydrate();
  notesCache = notesCache.filter((n) => n.id !== id);
  notifyNotes();
  await persistNotes();
}
