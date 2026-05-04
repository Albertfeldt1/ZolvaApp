// src/lib/mail-signature/storage.ts
//
// AsyncStorage persistence for SignatureData with per-user isolation
// and silent migration from v1 plaintext (per-user OR legacy global).
//
// Storage keys:
//   zolva.mail.signature.v2.{uid}  — current JSON shape
//   zolva.mail.signature.{uid}     — v1 plaintext (per-user, pre-rich)
//   zolva.mail.signature           — legacy global plaintext (pre-multi-account)

import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeUserId } from '../auth';
import { EMPTY_SIGNATURE, type SignatureData, type SocialLink } from './types';

const v2Key = (uid: string) => `zolva.mail.signature.v2.${uid}`;
const v1Key = (uid: string) => `zolva.mail.signature.${uid}`;
const LEGACY_GLOBAL_KEY = 'zolva.mail.signature';

let cachedUserId: string | null = null;
let cachedData: SignatureData | null = null;
let cacheLoaded = false;

const listeners = new Set<(data: SignatureData | null) => void>();

subscribeUserId((uid) => {
  cachedUserId = uid;
  cachedData = null;
  cacheLoaded = false;
  notify();
});

function notify(): void {
  for (const fn of listeners) {
    try { fn(cachedData); } catch { /* swallow; one bad listener shouldn't sink others */ }
  }
}

export function subscribeSignature(fn: (data: SignatureData | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function loadFromStorage(uid: string): Promise<SignatureData | null> {
  const v2Raw = await AsyncStorage.getItem(v2Key(uid));
  if (v2Raw !== null) {
    try {
      const parsed = JSON.parse(v2Raw) as Partial<SignatureData> & { kind?: 'structured' | 'imported' };
      if (parsed.kind === 'imported') {
        return {
          kind: 'imported',
          html: typeof parsed.html === 'string' ? parsed.html : '',
          plaintext: typeof parsed.plaintext === 'string' ? parsed.plaintext : '',
          image: parsed.image ?? null,
          importedAt: typeof parsed.importedAt === 'number' ? parsed.importedAt : 0,
          socials: Array.isArray(parsed.socials) ? parsed.socials as SocialLink[] : [],
        };
      }
      // 'structured' OR missing kind (legacy v2 from before this feature)
      return {
        ...EMPTY_SIGNATURE,
        ...parsed,
        kind: 'structured',
        socials: Array.isArray(parsed.socials) ? parsed.socials as SocialLink[] : [],
      };
    } catch (err) {
      console.warn('[mail-signature] malformed v2 json, treating as no signature:', err);
      return null;
    }
  }

  const v1Raw = await AsyncStorage.getItem(v1Key(uid));
  if (v1Raw !== null) {
    const migrated: SignatureData = { ...EMPTY_SIGNATURE, customLines: v1Raw };
    await AsyncStorage.setItem(v2Key(uid), JSON.stringify(migrated));
    await AsyncStorage.removeItem(v1Key(uid));
    return migrated;
  }

  const legacy = await AsyncStorage.getItem(LEGACY_GLOBAL_KEY);
  if (legacy !== null) {
    const migrated: SignatureData = { ...EMPTY_SIGNATURE, customLines: legacy };
    await AsyncStorage.setItem(v2Key(uid), JSON.stringify(migrated));
    await AsyncStorage.removeItem(LEGACY_GLOBAL_KEY);
    return migrated;
  }

  return null;
}

// Public API. Accepts an explicit uid for tests; runtime callers use the
// no-arg overload below which reads cachedUserId.
export async function loadSignature(uid?: string): Promise<SignatureData | null> {
  const targetUid = uid ?? cachedUserId;
  if (!targetUid) return null;

  // Cache only the current user's data so subscribers stay in sync.
  if (uid && uid !== cachedUserId) {
    return loadFromStorage(uid);
  }
  if (!cacheLoaded) {
    cachedData = await loadFromStorage(targetUid);
    cacheLoaded = true;
  }
  return cachedData;
}

export async function saveSignature(uid: string | null | undefined, data: SignatureData): Promise<void>;
export async function saveSignature(data: SignatureData): Promise<void>;
export async function saveSignature(a: any, b?: any): Promise<void> {
  const uid: string | null = typeof a === 'string' || a === null || a === undefined
    ? a ?? cachedUserId
    : cachedUserId;
  const data: SignatureData = typeof a === 'string' || a === null || a === undefined ? b : a;
  if (!uid) return;
  try {
    await AsyncStorage.setItem(v2Key(uid), JSON.stringify(data));
    if (uid === cachedUserId) {
      cachedData = data;
      cacheLoaded = true;
      notify();
    }
  } catch (err) {
    console.warn('[mail-signature] save failed:', err);
  }
}

// Test hooks — not exported via index.ts.
export function __resetForTests(): void {
  cachedUserId = null;
  cachedData = null;
  cacheLoaded = false;
  listeners.clear();
}

export function __setCurrentUserForTests(uid: string | null): void {
  cachedUserId = uid;
  cachedData = null;
  cacheLoaded = false;
}
