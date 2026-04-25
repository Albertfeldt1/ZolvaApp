// src/lib/icloud-credentials.ts
//
// Three-state credential storage for iCloud (Apple ID + app-specific password).
// Backed by secureStorage (iOS Keychain / Android Keystore) per-user.
//
// State machine:
//   absent  -> setupScreen captures + saveCredential -> valid
//   valid   -> markInvalid (called on auth-failed mid-session) -> invalid
//   valid   -> clearCredential (user disconnects in Settings) -> absent
//   invalid -> setupScreen re-captures + saveCredential -> valid
//   invalid -> clearCredential (user disconnects) -> absent
//
// Platform behaviour for persistence across app reinstall:
//   - iOS: Keychain may survive uninstall. Existing SECURE_STORE_MIGRATION_FLAG
//     pattern in src/lib/auth.ts wipes orphaned entries on first launch after
//     install. This module relies on that pattern (no separate migration here).
//   - Android: Keystore wiped on uninstall. android.allowBackup=false in the
//     manifest prevents Auto Backup from syncing credentials to Google Drive.

import * as secureStorage from './secure-storage';

export type SyncCursor = { uidValidity: number; lastUid: number };
// v1 ignores SyncCursor — included so the storage shape doesn't have to
// change when/if server-side polling is added later.

export type IcloudCredential = {
  email: string;
  password: string;
  lastSyncCursor: SyncCursor | null;
};

export type IcloudCredentialState =
  | { kind: 'absent' }
  | { kind: 'valid';   credential: IcloudCredential }
  | { kind: 'invalid'; credential: IcloudCredential; reason?: string };

const credKey = (uid: string) => `zolva.${uid}.icloud.credential`;

type StoredShape = {
  email: string;
  password: string;
  lastSyncCursor: SyncCursor | null;
  state: 'valid' | 'invalid';
  invalidReason?: string;
};

export async function loadCredential(userId: string): Promise<IcloudCredentialState> {
  if (!userId) return { kind: 'absent' };
  const raw = await secureStorage.getItem(credKey(userId));
  if (!raw) return { kind: 'absent' };
  let parsed: StoredShape;
  try {
    parsed = JSON.parse(raw) as StoredShape;
  } catch {
    return { kind: 'absent' };
  }
  if (
    typeof parsed.email !== 'string' ||
    typeof parsed.password !== 'string'
  ) {
    return { kind: 'absent' };
  }
  const credential: IcloudCredential = {
    email: parsed.email,
    password: parsed.password,
    lastSyncCursor: parsed.lastSyncCursor ?? null,
  };
  if (parsed.state === 'invalid') {
    return { kind: 'invalid', credential, reason: parsed.invalidReason };
  }
  return { kind: 'valid', credential };
}

export async function saveCredential(
  userId: string,
  email: string,
  password: string,
): Promise<void> {
  if (!userId) throw new Error('saveCredential: missing userId');
  const trimmedEmail = email.trim().toLowerCase();
  const cleanPwd = password.replace(/[\s-]/g, '');
  if (!trimmedEmail || !cleanPwd) {
    throw new Error('saveCredential: email and password required');
  }
  const stored: StoredShape = {
    email: trimmedEmail,
    password: cleanPwd,
    lastSyncCursor: null,
    state: 'valid',
  };
  await secureStorage.setItem(credKey(userId), JSON.stringify(stored));
}

export async function markInvalid(userId: string, reason?: string): Promise<void> {
  if (!userId) return;
  const current = await loadCredential(userId);
  if (current.kind === 'absent') return;
  const stored: StoredShape = {
    email: current.credential.email,
    password: current.credential.password,
    lastSyncCursor: current.credential.lastSyncCursor,
    state: 'invalid',
    invalidReason: reason,
  };
  await secureStorage.setItem(credKey(userId), JSON.stringify(stored));
}

export async function clearCredential(userId: string): Promise<void> {
  if (!userId) return;
  await secureStorage.deleteItem(credKey(userId));
}
