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
import { buildDemoSession, isDemoCredentials, isDemoUser } from './demo';
import {
  getNotificationSettings,
  hydrateNotificationSettingsForUser,
} from './notification-settings';
import { registerPushToken, unregisterPushToken, setMailWatchersEnabled } from './push';

WebBrowser.maybeCompleteAuthSession();

const tokenKey = (provider: 'google' | 'microsoft', userId: string) =>
  `zolva.${provider}.provider_token.${userId}`;

const currentUserId = () => cachedSession?.user?.id ?? null;

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

const MICROSOFT_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.Read',
].join(' ');

const SECURE_STORE_MIGRATION_FLAG = 'zolva.migration.secure-store.v1';

let cachedSession: Session | null = null;
let cachedGoogleToken: string | null = null;
let cachedMicrosoftToken: string | null = null;
let initialized = false;

const sessionListeners = new Set<(s: Session | null) => void>();
const googleListeners = new Set<(t: string | null) => void>();
const microsoftListeners = new Set<(t: string | null) => void>();
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
    const uid = data.session?.user?.id ?? null;
    await hydrateNotificationSettingsForUser(uid);
    if (uid) {
      loadProviderTokens(uid);
      ensurePushTokenListener();
      void registerPushToken();
    }
  })();

  supabase.auth.onAuthStateChange((event, session) => {
    // Ignore Supabase events while demo is active (except explicit SIGNED_IN
    // as a real user — let that take over).
    if (isDemoUser(cachedSession?.user) && event !== 'SIGNED_IN') return;
    const prevUserId = cachedSession?.user?.id ?? null;
    const nextUserId = session?.user?.id ?? null;
    broadcastSession(session);
    if (prevUserId !== nextUserId) {
      broadcastGoogle(null);
      broadcastMicrosoft(null);
      void hydrateNotificationSettingsForUser(nextUserId);
      if (nextUserId) loadProviderTokens(nextUserId);
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

    const identities = cachedSession?.user?.identities ?? [];
    const alreadyLinked = identities.some((i) => i.provider === provider);

    let initiator;
    let usedLinkIdentity = false;
    if (cachedSession && !alreadyLinked) {
      const linked = await supabase.auth.linkIdentity({ provider, options: params });
      if (linked.error) {
        if (__DEV__) console.warn('[auth] linkIdentity failed, falling back to signInWithOAuth:', linked.error.message);
        initiator = await supabase.auth.signInWithOAuth({ provider, options: params });
      } else {
        initiator = linked;
        usedLinkIdentity = true;
      }
    } else {
      if (__DEV__ && alreadyLinked) {
        console.log('[auth] identity already linked to current user, using signInWithOAuth to refresh provider token');
      }
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
    } else if (!token && __DEV__) {
      console.warn('[auth] No provider_token in exchange response');
    }
    if (uid) {
      await persistProviderRefreshToken(uid, providerKey, refreshToken);
      await bootstrapMailWatcher(uid, providerKey);
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

async function silentRefresh(provider: 'google' | 'microsoft'): Promise<string | null> {
  const supabaseProvider = provider === 'google' ? 'google' : 'azure';
  const scopes = provider === 'google' ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
  const redirectTo = oauthRedirect();

  const queryParams: Record<string, string> = { prompt: 'none' };
  if (provider === 'google') queryParams.access_type = 'offline';

  if (__DEV__) console.log('[auth] silent refresh attempt:', provider);

  const initiator = await supabase.auth.signInWithOAuth({
    provider: supabaseProvider,
    options: { redirectTo, skipBrowserRedirect: true, scopes, queryParams },
  });
  if (initiator.error || !initiator.data?.url) {
    if (__DEV__) console.warn('[auth] silent refresh URL failed:', initiator.error?.message);
    return null;
  }

  const result = await WebBrowser.openAuthSessionAsync(initiator.data.url, redirectTo);
  if (result.type !== 'success' || !result.url) {
    if (__DEV__) console.warn('[auth] silent refresh browser result:', result.type);
    return null;
  }

  const { code, error: cbError } = parseCallback(result.url);
  if (cbError || !code) {
    if (__DEV__) console.warn('[auth] silent refresh callback error:', cbError);
    return null;
  }

  const exchange = await supabase.auth.exchangeCodeForSession(code);
  if (exchange.error) {
    if (__DEV__) console.warn('[auth] silent refresh exchange failed:', exchange.error.message);
    return null;
  }

  const refreshToken = exchange.data.session?.provider_refresh_token ?? null;
  const uid = exchange.data.session?.user?.id ?? currentUserId();
  if (uid && refreshToken) {
    await persistProviderRefreshToken(uid, provider, refreshToken);
  }

  return exchange.data.session?.provider_token ?? null;
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

  useEffect(() => {
    init();
    sessionListeners.add(setSession);
    googleListeners.add(setGoogleToken);
    microsoftListeners.add(setMicrosoftToken);
    if (initializing) {
      const id = setTimeout(() => setInitializing(false), 0);
      return () => {
        clearTimeout(id);
        sessionListeners.delete(setSession);
        googleListeners.delete(setGoogleToken);
        microsoftListeners.delete(setMicrosoftToken);
      };
    }
    return () => {
      sessionListeners.delete(setSession);
      googleListeners.delete(setGoogleToken);
      microsoftListeners.delete(setMicrosoftToken);
    };
  }, [initializing]);

  return {
    session,
    user: session?.user ?? null,
    googleAccessToken: googleToken,
    microsoftAccessToken: microsoftToken,
    initializing,
    signIn: (email: string, password: string) =>
      signInWithPasswordOrDemo(email, password),
    signUp: (email: string, password: string) =>
      supabase.auth.signUp({ email, password }),
    signOut: performSignOut,
    signInWithGoogle,
    signInWithMicrosoft,
    signInWithApple,
    appleAvailable: Platform.OS === 'ios',
  };
}
