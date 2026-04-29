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

import { supabase } from './supabase';
import * as secureStorage from './secure-storage';
import { discoverCalendarHome } from './icloud-calendar';

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

// Empty userId returns 'absent' (not throw) — read paths run during auth-state resolution.
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
  if (parsed.state === 'valid') return { kind: 'valid', credential };
  if (parsed.state === 'invalid') {
    return { kind: 'invalid', credential, reason: parsed.invalidReason };
  }
  return { kind: 'absent' };
}

// Error codes surfaced by saveCredential / clearCredential when the
// server-link round trip fails. Local persistence is rolled back so the
// user retries the connect flow rather than ending up half-set-up.
export type IcloudLinkError =
  | 'discovery-failed'   // CalDAV PROPFIND chain failed (auth/network/protocol)
  | 'reauth-required'    // server iat-recency gate; client should refresh + retry
  | 'rate-limited'       // server rate limit hit
  | 'network'            // local fetch failed before reaching the function
  | 'server';            // any other server-side failure

export class IcloudLinkFailure extends Error {
  constructor(public code: IcloudLinkError, message?: string) {
    super(message ?? code);
    this.name = 'IcloudLinkFailure';
  }
}

type LinkResponseBody =
  | { ok: true }
  | { ok: false; code: 'reauth_required' | 'rate_limited' | 'invalid_request' | 'unauthorized' | 'server_error' };

async function callLinkEndpoint(
  email: string,
  password: string,
  calendarHomeUrl: string,
): Promise<void> {
  const { data, error } = await supabase.functions.invoke<LinkResponseBody>('icloud-creds-link', {
    method: 'POST',
    body: { email, password, calendar_home_url: calendarHomeUrl },
  });

  // supabase-js wraps non-2xx as a FunctionsHttpError where error.context is
  // a Response. Reading its body gives us the actual { ok:false, code:'...' }
  // payload so we can route to the right IcloudLinkFailure code instead of
  // a generic 'network'. Without this, every 401/429/etc. shows up as
  // "Edge Function returned a non-2xx status code" with no actionable info.
  if (error) {
    let parsed: LinkResponseBody | null = null;
    let status = 0;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      status = ctx.status;
      try { parsed = (await ctx.json()) as LinkResponseBody; } catch { parsed = null; }
    }
    if (parsed && parsed.ok === false) {
      switch (parsed.code) {
        case 'reauth_required': throw new IcloudLinkFailure('reauth-required', `${status} reauth_required`);
        case 'rate_limited':    throw new IcloudLinkFailure('rate-limited', `${status} rate_limited`);
        case 'unauthorized':    throw new IcloudLinkFailure('server', `${status} unauthorized — check JWT auth`);
        case 'invalid_request': throw new IcloudLinkFailure('server', `${status} invalid_request — body validation`);
        case 'server_error':    throw new IcloudLinkFailure('server', `${status} server_error`);
        default:                throw new IcloudLinkFailure('server', `${status} ${parsed.code}`);
      }
    }
    throw new IcloudLinkFailure('network', `${error.message}${status ? ` (HTTP ${status})` : ''}`);
  }

  if (!data || !('ok' in data)) {
    throw new IcloudLinkFailure('server', 'malformed link response');
  }
  if (data.ok === true) return;
  switch (data.code) {
    case 'reauth_required': throw new IcloudLinkFailure('reauth-required');
    case 'rate_limited':    throw new IcloudLinkFailure('rate-limited');
    default:                throw new IcloudLinkFailure('server', data.code);
  }
}

async function callRevokeEndpoint(): Promise<void> {
  // Revoke is best-effort. Local clear must still happen; if the server
  // call fails, we log and proceed — the user has explicitly chosen to
  // disconnect. Stale server rows get cleared on next link or on
  // ON DELETE CASCADE if the auth.users row is deleted.
  try {
    const { error } = await supabase.functions.invoke('icloud-creds-revoke', {
      method: 'POST',
    });
    if (error && __DEV__) {
      console.warn('[icloud-creds] revoke failed (continuing local clear):', error.message);
    }
  } catch (e) {
    if (__DEV__) console.warn('[icloud-creds] revoke threw (continuing local clear):', e);
  }
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

  // Local-first: persist creds before discovery so loadCredential calls
  // from within discoverCalendarHome (transitive via fullDiscover →
  // markInvalid path on auth-failed) see the new credential, not the
  // previous one. We roll back on any failure below.
  const stored: StoredShape = {
    email: trimmedEmail,
    password: cleanPwd,
    lastSyncCursor: null,
    state: 'valid',
  };
  await secureStorage.setItem(credKey(userId), JSON.stringify(stored));

  try {
    const discovery = await discoverCalendarHome(trimmedEmail, cleanPwd, userId);
    if (!discovery.ok) {
      throw new IcloudLinkFailure('discovery-failed', discovery.error);
    }
    await callLinkEndpoint(trimmedEmail, cleanPwd, discovery.data.calendarHomeUrl);
  } catch (e) {
    // Roll back local persistence so the UI doesn't show "iCloud connected"
    // in a half-linked state. discoverCalendarHome may have written a
    // discovery cache entry; clear it too.
    await secureStorage.deleteItem(credKey(userId));
    const { clearDiscoveryCacheFor } = await import('./icloud-calendar');
    await clearDiscoveryCacheFor(userId);
    throw e;
  }
}

export async function markInvalid(userId: string, reason?: string): Promise<void> {
  if (!userId) throw new Error('markInvalid: missing userId');
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
  if (!userId) throw new Error('clearCredential: missing userId');

  // Auto-clear any voice-routing labels pointing at iCloud — a stale
  // label can never silently mis-route a voice call to a calendar the
  // user has just disconnected. Mirrors the disconnectProvider auto-clear
  // for google/microsoft in auth.ts.
  try {
    const { readCalendarLabels, setCalendarLabel } = await import('./calendar-labels');
    const labels = await readCalendarLabels(userId);
    await Promise.all(
      (Object.entries(labels) as Array<[
        'work' | 'personal',
        { provider: 'google' | 'microsoft' | 'icloud'; id: string } | undefined,
      ]>).map(async ([key, target]) => {
        if (target?.provider === 'icloud') {
          await setCalendarLabel(userId, key, null);
        }
      }),
    );
  } catch (err) {
    if (__DEV__) console.warn('[icloud-creds] auto-clear voice labels failed:', err);
  }

  // Server revoke (best-effort). Even if it fails, we proceed with the
  // local clear — the user explicitly asked to disconnect.
  await callRevokeEndpoint();
  await secureStorage.deleteItem(credKey(userId));
}
