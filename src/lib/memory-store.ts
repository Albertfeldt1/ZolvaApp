// Persistent store for notes. Written to AsyncStorage so entries survive app
// restart. useNotes subscribes to the listener set here. Chat tool handlers
// mutate via addNote / removeNote.
//
// Storage is scoped to the active Supabase user id. Signing in as a different
// user swaps the in-memory cache and rehydrates from that user's keys —
// previous user's notes never leak.
//
// Reminders have been migrated to the server-backed src/lib/reminders.ts
// module. This file now handles notes only.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeUserId } from './auth';
import type { Note, NoteCategory } from './types';

const notesKey = (uid: string) => `zolva.${uid}.memory.notes`;

let currentUid: string | null = null;
let notesCache: Note[] = [];
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

const notesListeners = new Set<(n: Note[]) => void>();

function notifyNotes() {
  const snapshot = notesCache;
  notesListeners.forEach((l) => l(snapshot));
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
      const notesRaw = await AsyncStorage.getItem(notesKey(uid));
      // Bail if the active user changed during the read — the effect for
      // the new user will run its own hydrate.
      if (uid !== currentUid) return;
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
    notesCache = [];
    hydrated = false;
    hydrationPromise = null;
    notifyNotes();
    if (uid) void hydrate();
  });
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

export function subscribeNotes(listener: (n: Note[]) => void): () => void {
  ensureUserSubscription();
  notesListeners.add(listener);
  void hydrate();
  listener(notesCache);
  return () => {
    notesListeners.delete(listener);
  };
}

export function listNotes(): Note[] {
  return notesCache;
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
