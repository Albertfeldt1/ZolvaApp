// Manual test plan — two-account cross-contamination
// ----------------------------------------------------
// Goal: verify that signing out of account A and into account B on the
// same device does not cause B to receive A's newMail push notifications,
// and that no secrets from A remain on disk after sign-out.
//
//  1. Fresh install (or `adb uninstall` / delete app from simulator) so the
//     migration flags don't short-circuit.
//  2. Sign in as account A (Google). Enable the "Nye mails" toggle in
//     Settings. Send a test mail to A's inbox — confirm a push arrives.
//  3. In a keychain inspector (macOS Keychain Access for the simulator, or
//     `adb shell run-as com.zolva.app ls` on Android) confirm
//     `zolva.google.provider_token.<A_uid>` is present and AsyncStorage
//     no longer contains the same key.
//  4. Trigger signOut from the app. Verify in the DB:
//       - mail_watchers rows for A are `enabled = false`
//       - push_tokens row for this device is removed
//       - user_oauth_tokens rows for A are gone
//     And on the device: secure-store has no `zolva.*.provider_token.*`
//     entries, and AsyncStorage has no `zolva.notifications.settings.<A_uid>`
//     left.
//  5. Sign in as account B (different Google account). Enable "Nye mails".
//  6. Send a test mail to A's inbox. Confirm NO push arrives on the device.
//     (A's watcher must be disabled server-side; B's device must not be
//     subscribed to A's mail_watcher.)
//  7. Send a test mail to B's inbox. Confirm a push arrives.
//  8. Sign out of B. Sign back in as A. The A-specific
//     `zolva.notifications.settings.<A_uid>` should be restored — toggles
//     reflect A's prior preferences, not B's.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as AppleAuthentication from 'expo-apple-authentication';
import { makeRedirectUri } from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as WebBrowser from 'expo-web-browser';
import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { supabase } from './supabase';
import * as secureStorage from './secure-storage';
import { writeSharedSession, clearSharedSession } from './keychain';
import { buildDemoSession, isDemoCredentials, isDemoUser } from './demo';
import {
  getNotificationSettings,
  hydrateNotificationSettingsForUser,
} from './notification-settings';
import { registerPushToken, unregisterPushToken, setMailWatchersEnabled } from './push';
import { recordUserEmailDomain } from './admin-consent';
import { readCalendarLabels, setCalendarLabel } from './calendar-labels';
import { migrateLocalRemindersToServer } from './reminders';

WebBrowser.maybeCompleteAuthSession();

const tokenKey = (provider: 'google' | 'microsoft', userId: string) =>
  `zolva.${provider}.provider_token.${userId}`;

const currentUserId = () => cachedSession?.user?.id ?? null;

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

const MICROSOFT_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
].join(' ');

const SECURE_STORE_MIGRATION_FLAG = 'zolva.migration.secure-store.v1';

let cachedSession: Session | null = null;
let cachedGoogleToken: string | null = null;
let cachedMicrosoftToken: string | null = null;
let initialized = false;
// True while an init-time silent refresh is in flight for that provider. The
// re-auth banner suppresses itself until this flips to false, so the banner
// doesn't flicker on every cold launch for users whose refresh succeeds.
let googleInitRefreshing = false;
let microsoftInitRefreshing = false;

const sessionListeners = new Set<(s: Session | null) => void>();
const googleListeners = new Set<(t: string | null) => void>();
const microsoftListeners = new Set<(t: string | null) => void>();
const googleInitRefreshingListeners = new Set<(b: boolean) => void>();
const microsoftInitRefreshingListeners = new Set<(b: boolean) => void>();
const userIdListeners = new Set<(uid: string | null) => void>();

let lastBroadcastUid: string | null | undefined = undefined;
const broadcastUserIdIfChanged = () => {
  const uid = cachedSession?.user?.id ?? null;
  if (lastBroadcastUid === uid) return;
  lastBroadcastUid = uid;
  userIdListeners.forEach((l) => l(uid));
};

export function subscribeUserId(listener: (uid: string | null) => void): () => void {
  init();
  userIdListeners.add(listener);
  listener(cachedSession?.user?.id ?? null);
  return () => {
    userIdListeners.delete(listener);
  };
}

const broadcastSession = (s: Session | null) => {
  cachedSession = s;
  sessionListeners.forEach((l) => l(s));
  broadcastUserIdIfChanged();
};

const broadcastGoogle = (t: string | null) => {
  cachedGoogleToken = t;
  googleListeners.forEach((l) => l(t));
};

const broadcastMicrosoft = (t: string | null) => {
  cachedMicrosoftToken = t;
  microsoftListeners.forEach((l) => l(t));
};

const setGoogleInitRefreshing = (b: boolean) => {
  googleInitRefreshing = b;
  googleInitRefreshingListeners.forEach((l) => l(b));
};
const setMicrosoftInitRefreshing = (b: boolean) => {
  microsoftInitRefreshing = b;
  microsoftInitRefreshingListeners.forEach((l) => l(b));
};

async function loadProviderTokens(userId: string) {
  const [gToken, mToken] = await Promise.all([
    secureStorage.getItem(tokenKey('google', userId)),
    secureStorage.getItem(tokenKey('microsoft', userId)),
  ]);
  if (gToken) broadcastGoogle(gToken);
  if (mToken) broadcastMicrosoft(mToken);
}

// One-time migration: anything we previously wrote to AsyncStorage
// (Supabase session blob, provider access tokens) gets copied into
// expo-secure-store on first boot with this version, then deleted from
// AsyncStorage. Guarded by a flag so subsequent launches are a no-op.
async function migrateAsyncStorageToSecureStore(): Promise<void> {
  try {
    const already = await AsyncStorage.getItem(SECURE_STORE_MIGRATION_FLAG);
    if (already) return;

    const allKeys = await AsyncStorage.getAllKeys();
    const candidates = allKeys.filter(
      (k) =>
        k.startsWith('sb-') ||
        k.startsWith('zolva.google.provider_token.') ||
        k.startsWith('zolva.microsoft.provider_token.'),
    );

    if (candidates.length > 0) {
      const pairs = await AsyncStorage.multiGet(candidates);
      for (const [key, value] of pairs) {
        if (!value) continue;
        try {
          await secureStorage.setItem(key, value);
          await AsyncStorage.removeItem(key);
        } catch (err) {
          if (__DEV__) console.warn('[auth] migration copy failed for', key, err);
        }
      }
    }

    await AsyncStorage.setItem(SECURE_STORE_MIGRATION_FLAG, '1');
    if (__DEV__) console.log('[auth] secure-store migration complete:', candidates.length);
  } catch (err) {
    if (__DEV__) console.warn('[auth] secure-store migration failed:', err);
  }
}

let pushTokenSubscription: { remove: () => void } | null = null;

// Expo rotates push tokens on its own schedule (APNs/FCM re-issues,
// reinstalls, etc). If we only registered at login, a long-lived session
// could silently end up with a stale token in the DB and stop receiving
// pushes. This listener catches rotations while the app is foregrounded
// and re-runs registerPushToken so the DB row is refreshed.
function ensurePushTokenListener() {
  if (pushTokenSubscription) return;
  pushTokenSubscription = Notifications.addPushTokenListener(() => {
    void registerPushToken();
  });
}

const init = () => {
  if (initialized) return;
  initialized = true;

  (async () => {
    await migrateAsyncStorageToSecureStore();

    const { data } = await supabase.auth.getSession();
    // Don't clobber an active demo session — the user may have already
    // signed in as demo while getSession was in flight.
    if (isDemoUser(cachedSession?.user)) return;
    broadcastSession(data.session);
    if (data.session?.access_token && data.session?.refresh_token) {
      void writeSharedSession(data.session.access_token, data.session.refresh_token).catch((err) => {
        if (__DEV__) console.warn('[auth] writeSharedSession (init) failed:', err);
      });
    }
    const uid = data.session?.user?.id ?? null;
    await hydrateNotificationSettingsForUser(uid);
    if (uid) {
      await loadProviderTokens(uid);
      // For each provider in the user's identities, if we don't have a cached
      // access token, try one silent refresh. If a refresh_token exists in
      // user_oauth_tokens this populates the token; if it doesn't (e.g. the
      // user signed in pre-broker, or the broker upsert failed), the token
      // stays null and the InboxScreen banner can prompt re-auth. Without
      // this, those users sat with `microsoftAccessToken === null` forever
      // and Outlook mails were silently absent from the inbox.
      const providers = (data.session?.user?.app_metadata?.providers as string[] | undefined) ?? [];
      if (providers.includes('azure') && !cachedMicrosoftToken) {
        void trySilentRefreshAndBroadcast('microsoft');
      }
      if (providers.includes('google') && !cachedGoogleToken) {
        void trySilentRefreshAndBroadcast('google');
      }
      ensurePushTokenListener();
      void registerPushToken();
      void migrateLocalRemindersToServer(uid);
    }
  })();

  supabase.auth.onAuthStateChange((event, session) => {
    // Ignore Supabase events while demo is active (except explicit SIGNED_IN
    // as a real user — let that take over).
    if (isDemoUser(cachedSession?.user) && event !== 'SIGNED_IN') return;
    const prevUserId = cachedSession?.user?.id ?? null;
    const nextUserId = session?.user?.id ?? null;
    broadcastSession(session);
    // Mirror Supabase access + refresh token into the shared keychain so the
    // Siri-dispatched AppIntent can read them. Best-effort — keychain failures
    // are not fatal; voice will surface "logget ud" gracefully.
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.access_token && session?.refresh_token) {
      void writeSharedSession(session.access_token, session.refresh_token).catch((err) => {
        if (__DEV__) console.warn('[auth] writeSharedSession failed:', err);
      });
    }
    if (event === 'SIGNED_OUT') {
      void clearSharedSession().catch((err) => {
        if (__DEV__) console.warn('[auth] clearSharedSession failed:', err);
      });
    }
    if (prevUserId !== nextUserId) {
      broadcastGoogle(null);
      broadcastMicrosoft(null);
      void hydrateNotificationSettingsForUser(nextUserId);
      if (nextUserId) {
        void loadProviderTokens(nextUserId).then(() => {
          // Same proactive-refresh as init() — covers the user-switch /
          // sign-back-in flow where loadProviderTokens finds nothing in the
          // new user's secure-store but the server still has a refresh_token.
          const providers = (session?.user?.app_metadata?.providers as string[] | undefined) ?? [];
          if (providers.includes('azure') && !cachedMicrosoftToken) {
            void trySilentRefreshAndBroadcast('microsoft');
          }
          if (providers.includes('google') && !cachedGoogleToken) {
            void trySilentRefreshAndBroadcast('google');
          }
        });
      }
    }
    if (event === 'SIGNED_IN' && nextUserId) {
      ensurePushTokenListener();
      void registerPushToken();
    }
  });

  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
};

const oauthRedirect = () => makeRedirectUri({ scheme: 'zolva', path: 'auth/callback' });

const parseCallback = (raw: string): { code: string | null; error: string | null } => {
  try {
    const u = new URL(raw);
    const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
    const hashParams = new URLSearchParams(hash);
    const code = u.searchParams.get('code') ?? hashParams.get('code');
    const errorDesc =
      u.searchParams.get('error_description') ??
      hashParams.get('error_description') ??
      u.searchParams.get('error') ??
      hashParams.get('error');
    return { code, error: errorDesc };
  } catch {
    return { code: null, error: null };
  }
};

async function runOAuth(provider: 'google' | 'azure', scopes: string) {
  try {
    const redirectTo = oauthRedirect();
    if (__DEV__) console.log('[auth] OAuth', provider, 'redirect URI:', redirectTo);

    const queryParams: Record<string, string> =
      provider === 'google'
        ? { access_type: 'offline', prompt: 'consent' }
        : { prompt: 'consent' };

    const params = {
      redirectTo,
      skipBrowserRedirect: true,
      scopes,
      queryParams,
    };

    // Supabase quirk: signInWithOAuth on an already-linked identity returns
    // a session WITHOUT provider_token / provider_refresh_token, so we never
    // capture an access token to store and the UI flips to "disconnected"
    // on every cold launch. linkIdentity DOES forward both tokens, so when
    // the identity is already linked we unlink it first and re-enter through
    // linkIdentity. Unlink fails if it would leave the user with no
    // identities; in that case we fall through to the legacy path.
    const initiallyHadSession = !!cachedSession;
    const identities = cachedSession?.user?.identities ?? [];
    const linkedIdentity = identities.find((i) => i.provider === provider);
    const initiallyLinked = !!linkedIdentity;
    let identityUnlinked = false;
    let unlinkSoleIdentity = false;
    let unlinkOtherError = false;
    if (cachedSession && linkedIdentity) {
      const { error: unlinkError } = await supabase.auth.unlinkIdentity(linkedIdentity);
      if (unlinkError) {
        const msg = unlinkError.message ?? '';
        // Supabase returns 422 single_identity_not_deletable when the user has
        // only this identity. Without recovery, the downstream signInWithOAuth
        // call returns a session WITHOUT provider_refresh_token (Supabase
        // quirk for already-linked identity, see comment above), the row
        // never gets persisted to user_oauth_tokens, silentRefresh has
        // nothing to exchange on every future expiry, and the iOS OAuth
        // dialog fires hourly forever. Sign out so the next signInWithOAuth
        // runs the fresh-login path, which DOES forward provider_refresh_token.
        if (msg.includes('single_identity_not_deletable') || msg.includes('at least 1 identity')) {
          console.log('[auth] forcing sign-out before re-auth — sole-identity user');
          await supabase.auth.signOut();
          unlinkSoleIdentity = true;
        } else {
          console.warn('[auth] unlinkIdentity failed (using signInWithOAuth fallback):', msg);
          unlinkOtherError = true;
        }
      } else {
        identityUnlinked = true;
      }
    }

    let initiator;
    let usedLinkIdentity = false;
    let initiatorPath:
      | 'fresh-signin'
      | 'link-identity'
      | 'link-fallback-signin'
      | 'unlink-then-link'
      | 'unlink-then-link-fallback-signin'
      | 'force-signout-then-signin'
      | 'signin-already-linked-quirk' = 'fresh-signin';
    if (initiallyHadSession && initiallyLinked) {
      if (identityUnlinked) initiatorPath = 'unlink-then-link';
      else if (unlinkSoleIdentity) initiatorPath = 'force-signout-then-signin';
      else if (unlinkOtherError) initiatorPath = 'signin-already-linked-quirk';
    } else if (initiallyHadSession && !initiallyLinked) {
      initiatorPath = 'link-identity';
    }
    const useLinkIdentity = cachedSession && (!linkedIdentity || identityUnlinked);
    if (useLinkIdentity) {
      const linked = await supabase.auth.linkIdentity({ provider, options: params });
      if (linked.error) {
        console.warn('[auth] linkIdentity failed, falling back to signInWithOAuth:', linked.error.message);
        initiator = await supabase.auth.signInWithOAuth({ provider, options: params });
        initiatorPath =
          initiatorPath === 'unlink-then-link'
            ? 'unlink-then-link-fallback-signin'
            : 'link-fallback-signin';
      } else {
        initiator = linked;
        usedLinkIdentity = true;
      }
    } else {
      initiator = await supabase.auth.signInWithOAuth({ provider, options: params });
    }

    if (initiator.error || !initiator.data?.url) {
      return { data: null, error: initiator.error ?? new Error('No OAuth URL returned') };
    }

    if (__DEV__) console.log('[auth] OAuth URL:', initiator.data.url);

    let parsedAuthUrl: URL;
    try {
      parsedAuthUrl = new URL(initiator.data.url);
    } catch {
      return { data: null, error: new Error(`Supabase returnerede ugyldig OAuth URL: ${initiator.data.url}`) };
    }
    if (parsedAuthUrl.protocol !== 'https:' && parsedAuthUrl.protocol !== 'http:') {
      return { data: null, error: new Error(`OAuth URL har ugyldigt scheme: ${parsedAuthUrl.protocol}`) };
    }

    const result = await WebBrowser.openAuthSessionAsync(parsedAuthUrl.toString(), redirectTo);
    if (__DEV__) console.log('[auth] WebBrowser', provider, 'result:', result.type);

    if (result.type !== 'success' || !result.url) {
      return {
        data: null,
        error: result.type === 'cancel' ? null : new Error('OAuth-flowet blev afbrudt — tjek Supabase Redirect URLs.'),
      };
    }

    const { code, error: callbackError } = parseCallback(result.url);
    if (callbackError) {
      return { data: null, error: new Error(callbackError) };
    }
    if (!code) return { data: null, error: new Error('Ingen kode modtaget fra OAuth-udbyder.') };

    if (__DEV__) console.log('[auth] Exchanging code for session (linkIdentity:', usedLinkIdentity, ')');
    const exchange = await supabase.auth.exchangeCodeForSession(code);
    if (exchange.error) {
      if (__DEV__) console.warn('[auth] exchangeCodeForSession error:', exchange.error.message);
      return { data: null, error: exchange.error };
    }

    const token = exchange.data.session?.provider_token ?? null;
    const refreshToken = exchange.data.session?.provider_refresh_token ?? null;
    const uid = exchange.data.session?.user?.id ?? currentUserId();
    const providerKey = provider === 'google' ? 'google' : 'microsoft';
    if (token && uid) {
      try {
        await secureStorage.setItem(tokenKey(providerKey, uid), token);
        if (provider === 'google') broadcastGoogle(token);
        else broadcastMicrosoft(token);
      } catch (storageErr) {
        if (__DEV__) console.warn('[auth] token storage failed:', storageErr);
      }
    } else if (!token) {
      console.warn('[auth] No provider_token in exchange response (linkIdentity:', usedLinkIdentity, ')');
    }
    // Diagnostic: provider_token captured but no provider_refresh_token. This
    // is the silent-failure mode that causes hourly re-login dialogs — the
    // initial grant looks fine but no row gets written to user_oauth_tokens,
    // so silentRefresh has nothing to exchange when the access_token expires.
    // Logged with the initiator path so we can tell which Supabase code path
    // dropped the refresh_token (signin-already-linked-quirk is the known
    // failure mode; if we see others showing up, the unlink/link dance has
    // regressed).
    if (token && !refreshToken) {
      console.warn(
        '[oauth-grant] provider_token present but provider_refresh_token missing',
        JSON.stringify({
          provider: providerKey,
          userId: uid ? uid.slice(0, 8) : null,
          initiatorPath,
          usedLinkIdentity,
        }),
      );
    }
    if (uid) {
      await persistProviderRefreshToken(uid, providerKey, refreshToken);
      await bootstrapMailWatcher(uid, providerKey);
      // Capture the user's email domain so we can size the admin-consent
      // feature's actual reach (enterprise vs consumer). Best-effort, never
      // blocks; PK conflict on second sign-in is silently ignored.
      void recordUserEmailDomain(uid, exchange.data.session?.user?.email ?? null);
    }
    return { data: exchange.data, error: null };
  } catch (e) {
    if (__DEV__) console.error('[auth] runOAuth threw:', e);
    return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

// Upsert the provider's refresh token into user_oauth_tokens so the
// poll-mail edge function can mint fresh access tokens for Gmail/Graph.
// Supabase returns `provider_refresh_token` for Google when we ask for
// offline+consent, and for Microsoft via offline_access scope. If the
// value is null (silent refresh typically reuses the prior grant), we
// leave whatever is already stored in place rather than overwrite with
// nothing.
async function persistProviderRefreshToken(
  userId: string,
  provider: 'google' | 'microsoft',
  refreshToken: string | null,
): Promise<void> {
  if (!refreshToken) return;
  const { error } = await supabase
    .from('user_oauth_tokens')
    .upsert(
      {
        user_id: userId,
        provider,
        refresh_token: refreshToken,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider' },
    );
  if (error && __DEV__) {
    console.warn('[auth] persist refresh token failed:', error.message);
  }
}

// Ensure a mail_watchers row exists for the (user, provider) pair. Sets
// `enabled` to match the user's current newMail preference so toggling it
// later is the only thing that controls server-side polling.
async function bootstrapMailWatcher(
  userId: string,
  provider: 'google' | 'microsoft',
): Promise<void> {
  const enabled = getNotificationSettings().newMail;
  const { error } = await supabase
    .from('mail_watchers')
    .upsert(
      {
        user_id: userId,
        provider,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider' },
    );
  if (error && __DEV__) {
    console.warn('[auth] bootstrap mail watcher failed:', error.message);
  }
}

async function signInWithGoogle() {
  return runOAuth('google', GOOGLE_SCOPES);
}

async function signInWithMicrosoft() {
  return runOAuth('azure', MICROSOFT_SCOPES);
}

export class ProviderAuthError extends Error {
  readonly provider: 'google' | 'microsoft';
  constructor(provider: 'google' | 'microsoft', message: string) {
    super(message);
    this.name = 'ProviderAuthError';
    this.provider = provider;
  }
}

let googleRefreshInflight: Promise<string | null> | null = null;
let microsoftRefreshInflight: Promise<string | null> | null = null;

// Refresh the provider access_token via the server-side edge function.
// Previously this opened ASWebAuthenticationSession with prompt=none, but
// iOS still shows its "App wants to use supabase.co to sign you in" dialog
// every cold-launch for any browser auth — completely unsuppressable. The
// edge function does the refresh_token → access_token exchange server-side
// using the stored refresh_token + server-held client_secret, so no
// browser is involved and the dialog never fires on the hot path.
async function silentRefresh(provider: 'google' | 'microsoft'): Promise<string | null> {
  if (__DEV__) console.log('[auth] silent refresh attempt:', provider);

  try {
    const { data, error } = await supabase.functions.invoke<{
      access_token?: string;
      expires_in?: number;
      error?: string;
    }>('refresh-provider-token', {
      body: { provider },
    });
    if (error) {
      if (__DEV__) console.warn('[auth] refresh-provider-token err:', error.message);
      return null;
    }
    const token = (data as { access_token?: string } | null)?.access_token ?? null;
    if (!token && __DEV__) {
      console.warn('[auth] refresh-provider-token returned no token:', data);
    }
    return token;
  } catch (err) {
    if (__DEV__) console.warn('[auth] refresh-provider-token threw:', err);
    return null;
  }
}

// Init-time proactive refresh — calls silentRefresh ONLY (no full-OAuth
// fallback). On success, persists the token and broadcasts it so the inbox
// can include this provider on the first render. On failure (e.g. no
// refresh_token row server-side), leaves the broadcast at null so the
// re-auth banner can prompt the user. Using doRefresh/startRefresh here
// would surprise-pop ASWebAuthenticationSession on every cold launch for
// users who can't silently refresh — exactly the dialog the silent-refresh
// machinery was added to suppress.
async function trySilentRefreshAndBroadcast(provider: 'google' | 'microsoft'): Promise<void> {
  if (provider === 'google') setGoogleInitRefreshing(true);
  else setMicrosoftInitRefreshing(true);
  try {
    let token: string | null = null;
    try {
      token = await silentRefresh(provider);
    } catch (err) {
      if (__DEV__) console.warn('[auth] init-time silent refresh threw:', err);
      return;
    }
    if (!token) return;
    const uid = currentUserId();
    if (uid) {
      try {
        await secureStorage.setItem(tokenKey(provider, uid), token);
      } catch (err) {
        if (__DEV__) console.warn('[auth] init-time token persist failed:', err);
      }
    }
    if (provider === 'google') broadcastGoogle(token);
    else broadcastMicrosoft(token);
  } finally {
    if (provider === 'google') setGoogleInitRefreshing(false);
    else setMicrosoftInitRefreshing(false);
  }
}

async function doRefresh(provider: 'google' | 'microsoft'): Promise<string | null> {
  let token: string | null = null;
  try {
    token = await silentRefresh(provider);
  } catch (e) {
    if (__DEV__) console.warn('[auth] silent refresh threw:', e);
  }

  if (!token) {
    if (__DEV__) console.log('[auth] silent refresh unavailable, falling back to full re-auth:', provider);
    const full = await runOAuth(provider === 'google' ? 'google' : 'azure', provider === 'google' ? GOOGLE_SCOPES : MICROSOFT_SCOPES);
    if (full.error) {
      if (__DEV__) console.warn('[auth] full re-auth failed:', full.error.message);
      return null;
    }
    token = provider === 'google' ? cachedGoogleToken : cachedMicrosoftToken;
    if (token) return token;
  }

  if (!token) return null;

  const uid = currentUserId();
  if (uid) {
    try {
      await secureStorage.setItem(tokenKey(provider, uid), token);
    } catch (e) {
      if (__DEV__) console.warn('[auth] token persist failed:', e);
    }
  }
  if (provider === 'google') broadcastGoogle(token);
  else broadcastMicrosoft(token);
  return token;
}

function startRefresh(provider: 'google' | 'microsoft'): Promise<string | null> {
  const existing = provider === 'google' ? googleRefreshInflight : microsoftRefreshInflight;
  if (existing) return existing;

  const p = doRefresh(provider).finally(() => {
    if (provider === 'google') googleRefreshInflight = null;
    else microsoftRefreshInflight = null;
  });
  if (provider === 'google') googleRefreshInflight = p;
  else microsoftRefreshInflight = p;
  return p;
}

async function clearProviderToken(provider: 'google' | 'microsoft') {
  const uid = currentUserId();
  if (uid) {
    await secureStorage.deleteItem(tokenKey(provider, uid));
  }
  if (provider === 'google') broadcastGoogle(null);
  else broadcastMicrosoft(null);
}

// User-initiated "Frakobl" — withdraw the OAuth grant for a single provider
// without signing the user out of Zolva. GDPR Art. 7(3): withdrawal must be
// as easy as giving consent.
//
// Teardown sequence mirrors performSignOut, scoped to one provider:
//   1. Best-effort revoke at Google (Microsoft has no clean revoke endpoint)
//   2. Delete user_oauth_tokens row so the server stops minting fresh tokens
//   3. Flip mail_watchers.enabled = false so the cron stops polling
//   4. Clear secure-store provider_token + broadcast null so the UI flips
export async function disconnectProvider(
  provider: 'google' | 'microsoft',
): Promise<void> {
  init();
  const uid = currentUserId();
  if (!uid) return;

  // Auto-clear any voice-routing labels that point at this provider — a
  // stale label can never silently mis-route a voice call to a calendar
  // the user no longer has access to.
  try {
    const labels = await readCalendarLabels(uid);
    await Promise.all(
      (Object.entries(labels) as Array<[
        'work' | 'personal',
        { provider: 'google' | 'microsoft'; id: string } | undefined,
      ]>).map(async ([key, target]) => {
        if (target?.provider === provider) {
          await setCalendarLabel(uid, key, null);
        }
      }),
    );
  } catch (err) {
    // Demo user (no real DB row) or transient DB error — fall through. The
    // label is at worst stale; the Edge Function's defensive null-check on
    // resolution catches a row state where columns are inconsistent.
    if (__DEV__) console.warn('[auth] auto-clear calendar labels failed:', err);
  }

  // Demo user — no real tokens exist server-side. Just drop the local cache.
  if (isDemoUser(cachedSession?.user)) {
    if (provider === 'google') broadcastGoogle(null);
    else broadcastMicrosoft(null);
    return;
  }

  const token = provider === 'google' ? cachedGoogleToken : cachedMicrosoftToken;
  if (provider === 'google' && token) {
    await revokeGoogleToken(token);
  }

  await Promise.allSettled([
    supabase.from('user_oauth_tokens').delete().eq('user_id', uid).eq('provider', provider),
    supabase
      .from('mail_watchers')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('user_id', uid)
      .eq('provider', provider),
  ]);

  await clearProviderToken(provider);
}

export async function tryWithRefresh<T>(
  provider: 'google' | 'microsoft',
  fn: (token: string) => Promise<T>,
): Promise<T> {
  init();

  const initialToken = provider === 'google' ? cachedGoogleToken : cachedMicrosoftToken;
  if (!initialToken) {
    throw new ProviderAuthError(provider, `Ingen ${provider} access token tilgængelig.`);
  }

  try {
    return await fn(initialToken);
  } catch (err) {
    if (!(err instanceof ProviderAuthError) || err.provider !== provider) throw err;

    if (__DEV__) console.log('[auth] tryWithRefresh: auth error from', provider, '- refreshing');
    const fresh = await startRefresh(provider);
    if (!fresh) {
      await clearProviderToken(provider);
      throw err;
    }
    return await fn(fresh);
  }
}

async function signInWithApple() {
  if (Platform.OS !== 'ios') {
    return { data: null, error: new Error('Apple Sign In er kun tilgængelig på iOS.') };
  }

  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    nonce: hashedNonce,
  });

  if (!credential.identityToken) {
    return { data: null, error: new Error('Ingen identity token modtaget fra Apple') };
  }

  return supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce: rawNonce,
  });
}

// Best-effort POST to Google's revocation endpoint. Google accepts either
// an access token or a refresh token; revoking either invalidates all
// tokens in the grant. We fire-and-forget log — if it fails, the user may
// still have an active grant in their Google account but the app is
// already signed out locally, so this is not a blocking error.
async function revokeGoogleToken(accessToken: string): Promise<void> {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(accessToken)}`,
    });
  } catch (err) {
    if (__DEV__) console.warn('[auth] google revoke failed:', err);
  }
}

// Server-authoritative teardown. The teardown-user-session edge function
// is trusted to disable watchers and delete push tokens even if client
// RLS misbehaves. If the function isn't deployed yet or errors, fall back
// to the direct table operations (RLS permits users to mutate their own
// rows), so local teardown still completes.
async function runSignOutTeardown(userId: string): Promise<void> {
  const fn = supabase.functions.invoke('teardown-user-session', { body: {} });
  const { error } = await fn.catch((err: unknown) => ({
    error: err instanceof Error ? err : new Error(String(err)),
    data: null,
  }));

  if (error) {
    if (__DEV__) console.warn('[auth] teardown-user-session edge function unavailable, using client fallback:', error.message);
    await Promise.allSettled([
      setMailWatchersEnabled(false),
      unregisterPushToken(),
    ]);
  }

  // Always drop user_oauth_tokens regardless of edge function path — this
  // is the Microsoft revoke (Graph has no clean revoke endpoint) and
  // belt-and-braces for Google.
  const { error: tokErr } = await supabase
    .from('user_oauth_tokens')
    .delete()
    .eq('user_id', userId);
  if (tokErr && __DEV__) {
    console.warn('[auth] delete user_oauth_tokens failed:', tokErr.message);
  }
}

// Remove every AsyncStorage key we know is scoped to the signed-out user.
// The secure-store side is cleared separately because its keys are known
// up front (provider tokens + session).
async function clearUserScopedAsyncStorage(userId: string): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const scoped = allKeys.filter(
      (k) =>
        k === `zolva.notifications.settings.${userId}` ||
        k.endsWith(`.${userId}`) ||
        k.includes(`:${userId}`),
    );
    if (scoped.length > 0) await AsyncStorage.multiRemove(scoped);
  } catch (err) {
    if (__DEV__) console.warn('[auth] clearUserScopedAsyncStorage failed:', err);
  }
}

async function clearSecureStoreForUser(userId: string): Promise<void> {
  await Promise.all([
    secureStorage.deleteItem(tokenKey('google', userId)),
    secureStorage.deleteItem(tokenKey('microsoft', userId)),
  ]);
}

async function performSignOut(): Promise<void> {
  const uid = currentUserId();
  const googleToken = cachedGoogleToken;

  // Demo session lives entirely client-side — skip Supabase teardown, edge
  // function calls, and token revocation. Just drop the fake session.
  if (isDemoUser(cachedSession?.user)) {
    broadcastGoogle(null);
    broadcastMicrosoft(null);
    broadcastSession(null);
    return;
  }

  if (uid) {
    await runSignOutTeardown(uid);
  }

  if (googleToken) {
    await revokeGoogleToken(googleToken);
  }

  if (uid) {
    await clearSecureStoreForUser(uid);
    await clearUserScopedAsyncStorage(uid);
  }

  broadcastGoogle(null);
  broadcastMicrosoft(null);

  await supabase.auth.signOut();
}

function signInWithPasswordOrDemo(email: string, password: string) {
  if (isDemoCredentials(email, password)) {
    const session = buildDemoSession();
    broadcastSession(session);
    return Promise.resolve({
      data: { session, user: session.user },
      error: null,
    });
  }
  return supabase.auth.signInWithPassword({ email, password });
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(cachedSession);
  const [googleToken, setGoogleToken] = useState<string | null>(cachedGoogleToken);
  const [microsoftToken, setMicrosoftToken] = useState<string | null>(cachedMicrosoftToken);
  const [initializing, setInitializing] = useState(!initialized);
  const [googleRefreshingAtBoot, setGoogleRefreshingAtBoot] = useState(googleInitRefreshing);
  const [microsoftRefreshingAtBoot, setMicrosoftRefreshingAtBoot] = useState(microsoftInitRefreshing);

  useEffect(() => {
    init();
    sessionListeners.add(setSession);
    googleListeners.add(setGoogleToken);
    microsoftListeners.add(setMicrosoftToken);
    googleInitRefreshingListeners.add(setGoogleRefreshingAtBoot);
    microsoftInitRefreshingListeners.add(setMicrosoftRefreshingAtBoot);
    if (initializing) {
      const id = setTimeout(() => setInitializing(false), 0);
      return () => {
        clearTimeout(id);
        sessionListeners.delete(setSession);
        googleListeners.delete(setGoogleToken);
        microsoftListeners.delete(setMicrosoftToken);
        googleInitRefreshingListeners.delete(setGoogleRefreshingAtBoot);
        microsoftInitRefreshingListeners.delete(setMicrosoftRefreshingAtBoot);
      };
    }
    return () => {
      sessionListeners.delete(setSession);
      googleListeners.delete(setGoogleToken);
      microsoftListeners.delete(setMicrosoftToken);
      googleInitRefreshingListeners.delete(setGoogleRefreshingAtBoot);
      microsoftInitRefreshingListeners.delete(setMicrosoftRefreshingAtBoot);
    };
  }, [initializing]);

  return {
    session,
    user: session?.user ?? null,
    googleAccessToken: googleToken,
    microsoftAccessToken: microsoftToken,
    googleRefreshingAtBoot,
    microsoftRefreshingAtBoot,
    initializing,
    signIn: (email: string, password: string) =>
      signInWithPasswordOrDemo(email, password),
    signUp: (email: string, password: string) =>
      isDemoCredentials(email, password)
        ? signInWithPasswordOrDemo(email, password)
        : supabase.auth.signUp({ email, password }),
    signOut: performSignOut,
    signInWithGoogle,
    signInWithMicrosoft,
    signInWithApple,
    disconnectProvider,
    appleAvailable: Platform.OS === 'ios',
  };
}
