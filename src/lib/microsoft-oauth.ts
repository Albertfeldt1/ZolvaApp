// Microsoft custom OAuth driver - bypasses Supabase's gotrue azure provider.
//
// See docs/superpowers/specs/2026-05-10-microsoft-custom-oauth-design.md for
// the full design and root cause. TL;DR: gotrue 500s when graph.microsoft.com
// /me returns no email claim. We open login.microsoftonline.com directly with
// PKCE, hand the auth code to a server-side edge function for the secret-using
// exchange, and never call /me.

import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabase';

// Hardcoded - must match the redirect URI registered in the Azure app
// registration's "Mobile and desktop applications" platform. Changing this
// requires an Azure portal update first.
export const MICROSOFT_REDIRECT_URI = 'zolva://oauth/microsoft/callback';

const MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

const MICROSOFT_SCOPES = [
  'openid',
  'offline_access',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Files.Read',
].join(' ');

export type RunMicrosoftOAuthResult =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; cancelled: true }
  | { ok: false; error: Error };

// In-memory state→verifier map. Lives only across the open-browser-then-handle-
// redirect window (~30s typical). If the JS context dies (app killed long enough),
// the user just retaps "Forbind".
const pendingVerifiers = new Map<string, string>();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = '';
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  // 32 random bytes → 43-char base64url verifier (well within RFC 7636's 43-128 range).
  const verifier = base64url(Crypto.getRandomBytes(32));
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  // digestStringAsync returns standard base64; convert to base64url.
  const challenge = digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

export type ParsedCallback =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string };

export function parseMicrosoftCallback(rawUrl: string): ParsedCallback {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, error: 'invalid callback URL' }; }
  const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
  const hashParams = new URLSearchParams(hash);
  const errorDesc =
    u.searchParams.get('error_description') ??
    hashParams.get('error_description') ??
    u.searchParams.get('error') ??
    hashParams.get('error');
  if (errorDesc) return { ok: false, error: errorDesc };
  const code = u.searchParams.get('code') ?? hashParams.get('code');
  const state = u.searchParams.get('state') ?? hashParams.get('state');
  if (!code) return { ok: false, error: 'missing code in callback' };
  if (!state) return { ok: false, error: 'missing state in callback' };
  return { ok: true, code, state };
}

export function consumePendingVerifier(state: string): string | null {
  const v = pendingVerifiers.get(state);
  if (v === undefined) return null;
  pendingVerifiers.delete(state);
  return v;
}

export function rememberPendingVerifier(state: string, verifier: string): void {
  pendingVerifiers.set(state, verifier);
}

function buildAuthorizeUrl(input: {
  clientId: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: MICROSOFT_REDIRECT_URI,
    scope: MICROSOFT_SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    prompt: 'consent',
  });
  return `${MICROSOFT_AUTHORIZE_URL}?${params.toString()}`;
}

export type RunMicrosoftOAuthDeps = {
  getClientId: () => string | null;
  openAuthSession: (
    url: string,
    redirect: string,
  ) => Promise<{ type: string; url?: string }>;
  invokeExchange: (body: {
    code: string;
    code_verifier: string;
    redirect_uri: string;
    mail_watcher_enabled: boolean;
  }) => Promise<{ data: { access_token?: string; expires_in?: number } | null; error: { message: string; status?: number } | null }>;
  getMailWatcherEnabled: () => boolean;
};

// Pure orchestrator - dependencies injected for tests. Production callers use
// runMicrosoftOAuth which wires real expo-web-browser + supabase.functions.invoke.
export async function runMicrosoftOAuthWithDeps(
  deps: RunMicrosoftOAuthDeps,
): Promise<RunMicrosoftOAuthResult> {
  const clientId = deps.getClientId();
  if (!clientId) return { ok: false, error: new Error('Microsoft OAuth client_id missing') };

  const { verifier, challenge } = await generatePkce();
  const state = base64url(Crypto.getRandomBytes(16));
  rememberPendingVerifier(state, verifier);

  const authUrl = buildAuthorizeUrl({ clientId, challenge, state });
  const result = await deps.openAuthSession(authUrl, MICROSOFT_REDIRECT_URI);
  if (result.type !== 'success' || !result.url) {
    consumePendingVerifier(state); // clean up pending entry
    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { ok: false, cancelled: true };
    }
    return { ok: false, error: new Error(`OAuth-flowet blev afbrudt (${result.type})`) };
  }

  const parsed = parseMicrosoftCallback(result.url);
  if (parsed.ok === false) {
    consumePendingVerifier(state);
    return { ok: false, error: new Error(parsed.error) };
  }
  const storedVerifier = consumePendingVerifier(parsed.state);
  if (!storedVerifier) {
    return { ok: false, error: new Error('Forbindelsen blev afbrudt - prøv igen') };
  }
  if (parsed.state !== state) {
    return { ok: false, error: new Error('OAuth state mismatch') };
  }

  const exchange = await deps.invokeExchange({
    code: parsed.code,
    code_verifier: storedVerifier,
    redirect_uri: MICROSOFT_REDIRECT_URI,
    mail_watcher_enabled: deps.getMailWatcherEnabled(),
  });
  if (exchange.error) {
    return { ok: false, error: new Error(exchange.error.message) };
  }
  const accessToken = exchange.data?.access_token;
  if (!accessToken) {
    return { ok: false, error: new Error('No access_token returned from exchange') };
  }
  return { ok: true, accessToken, expiresIn: exchange.data?.expires_in ?? 3600 };
}

// Production wrapper - wires real dependencies. Imported by auth.ts.
export async function runMicrosoftOAuth(opts: {
  clientId: string | null;
  mailWatcherEnabled: boolean;
}): Promise<RunMicrosoftOAuthResult> {
  return runMicrosoftOAuthWithDeps({
    getClientId: () => opts.clientId,
    openAuthSession: (url, redirect) =>
      WebBrowser.openAuthSessionAsync(url, redirect) as Promise<{ type: string; url?: string }>,
    invokeExchange: async (body) => {
      const res = await supabase.functions.invoke<{ access_token?: string; expires_in?: number }>(
        'microsoft-oauth-exchange',
        { body },
      );
      if (!res.error) return { data: res.data, error: null };
      // supabase-js's FunctionsHttpError sets .message to a generic
      // "Edge Function returned a non-2xx status code" string and stashes the
      // Response on .context. Without unwrapping it, translateProviderError
      // has no signal to act on and the user sees the opaque generic copy.
      // Pull the JSON body so error codes (invalid-code, no-refresh-token,
      // exchange-failed, AADSTS…) surface in support screenshots.
      let detail = '';
      const ctx = (res.error as unknown as { context?: unknown }).context;
      if (ctx instanceof Response) {
        try {
          const text = await ctx.clone().text();
          if (text) {
            try {
              const parsed = JSON.parse(text) as { error?: string; detail?: string };
              detail = [parsed.error, parsed.detail].filter(Boolean).join(': ');
            } catch {
              detail = text.slice(0, 200);
            }
          }
        } catch {
          // Body already consumed or unreadable - fall through with empty detail.
        }
      }
      const status = (res.error as unknown as { status?: number }).status;
      const message = detail
        ? `microsoft-oauth-exchange ${status ?? ''} ${detail}`.trim()
        : res.error.message;
      return { data: null, error: { message, status } };
    },
    getMailWatcherEnabled: () => opts.mailWatcherEnabled,
  });
}
