import AsyncStorage from '@react-native-async-storage/async-storage';
import * as AppleAuthentication from 'expo-apple-authentication';
import { makeRedirectUri } from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { supabase } from './supabase';

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

let cachedSession: Session | null = null;
let cachedGoogleToken: string | null = null;
let cachedMicrosoftToken: string | null = null;
let initialized = false;

const sessionListeners = new Set<(s: Session | null) => void>();
const googleListeners = new Set<(t: string | null) => void>();
const microsoftListeners = new Set<(t: string | null) => void>();

const broadcastSession = (s: Session | null) => {
  cachedSession = s;
  sessionListeners.forEach((l) => l(s));
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
  const entries = await AsyncStorage.multiGet([
    tokenKey('google', userId),
    tokenKey('microsoft', userId),
  ]);
  for (const [key, value] of entries) {
    if (!value) continue;
    if (key.includes('.google.')) broadcastGoogle(value);
    else if (key.includes('.microsoft.')) broadcastMicrosoft(value);
  }
}

const init = () => {
  if (initialized) return;
  initialized = true;

  supabase.auth.getSession().then(({ data }) => {
    broadcastSession(data.session);
    const uid = data.session?.user?.id;
    if (uid) loadProviderTokens(uid);
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    const prevUserId = cachedSession?.user?.id ?? null;
    const nextUserId = session?.user?.id ?? null;
    broadcastSession(session);
    if (prevUserId !== nextUserId) {
      broadcastGoogle(null);
      broadcastMicrosoft(null);
      if (nextUserId) loadProviderTokens(nextUserId);
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
    const uid = exchange.data.session?.user?.id ?? currentUserId();
    if (token && uid) {
      try {
        const providerKey = provider === 'google' ? 'google' : 'microsoft';
        await AsyncStorage.setItem(tokenKey(providerKey, uid), token);
        if (provider === 'google') broadcastGoogle(token);
        else broadcastMicrosoft(token);
      } catch (storageErr) {
        if (__DEV__) console.warn('[auth] token storage failed:', storageErr);
      }
    } else if (!token && __DEV__) {
      console.warn('[auth] No provider_token in exchange response');
    }
    return { data: exchange.data, error: null };
  } catch (e) {
    if (__DEV__) console.error('[auth] runOAuth threw:', e);
    return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
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
      await AsyncStorage.setItem(tokenKey(provider, uid), token);
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
    try {
      await AsyncStorage.removeItem(tokenKey(provider, uid));
    } catch {}
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
      supabase.auth.signInWithPassword({ email, password }),
    signUp: (email: string, password: string) =>
      supabase.auth.signUp({ email, password }),
    signOut: async () => {
      // Tokens stay on disk, namespaced by user id — the session-change
      // handler drops them from memory. Signing back in restores them.
      await supabase.auth.signOut();
    },
    signInWithGoogle,
    signInWithMicrosoft,
    signInWithApple,
    appleAvailable: Platform.OS === 'ios',
  };
}
