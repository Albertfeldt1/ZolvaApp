// Manual mail signature storage. Used for providers where we cannot fetch
// the user's signature from the server (Outlook — Graph has no public API
// for OWA signatures; iCloud — IMAP carries no signature data). The user
// types their signature once in Settings and we append it before send/draft.
//
// Storage is per-user via AsyncStorage. Plain text only — kept deliberately
// simple so HTML/MIME assembly stays uniform with Gmail's plain-text path.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeUserId } from './auth';

const LEGACY_KEY = 'zolva.mail.signature';
const keyFor = (uid: string) => `zolva.mail.signature.${uid}`;
const MAX_LEN = 2000;

let cachedUserId: string | null = null;
let cachedSignature: string | null = null;
let cacheLoaded = false;

const listeners = new Set<(sig: string | null) => void>();

subscribeUserId((uid) => {
  cachedUserId = uid;
  cachedSignature = null;
  cacheLoaded = false;
  notify();
});

function notify(): void {
  for (const fn of listeners) {
    try {
      fn(cachedSignature);
    } catch {
      // swallow; one bad listener shouldn't sink others
    }
  }
}

export function subscribeManualSignature(fn: (sig: string | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function ensureLoaded(): Promise<void> {
  if (cacheLoaded) return;
  if (!cachedUserId) {
    cachedSignature = null;
    cacheLoaded = true;
    return;
  }
  try {
    const raw = await AsyncStorage.getItem(keyFor(cachedUserId));
    if (raw !== null) {
      cachedSignature = raw;
    } else {
      // Migrate any pre-multi-account signature once. The legacy key was
      // global; first user to read after upgrade inherits it, then we delete
      // it so subsequent users start blank.
      const legacy = await AsyncStorage.getItem(LEGACY_KEY);
      if (legacy !== null) {
        await AsyncStorage.setItem(keyFor(cachedUserId), legacy);
        await AsyncStorage.removeItem(LEGACY_KEY);
        cachedSignature = legacy;
      } else {
        cachedSignature = null;
      }
    }
  } catch (err) {
    if (__DEV__) console.warn('[mail-signature] load failed:', err);
    cachedSignature = null;
  }
  cacheLoaded = true;
}

export async function loadManualSignature(): Promise<string | null> {
  await ensureLoaded();
  return cachedSignature && cachedSignature.trim() ? cachedSignature : null;
}

export async function saveManualSignature(value: string): Promise<void> {
  if (!cachedUserId) return;
  const trimmed = value.slice(0, MAX_LEN);
  cachedSignature = trimmed.trim() ? trimmed : null;
  cacheLoaded = true;
  try {
    if (cachedSignature) {
      await AsyncStorage.setItem(keyFor(cachedUserId), cachedSignature);
    } else {
      await AsyncStorage.removeItem(keyFor(cachedUserId));
    }
  } catch (err) {
    if (__DEV__) console.warn('[mail-signature] save failed:', err);
  }
  notify();
}
