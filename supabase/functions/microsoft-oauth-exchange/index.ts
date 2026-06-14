// microsoft-oauth-exchange - Supabase Edge Function (user-scoped).
//
// Exchanges a Microsoft authorization code for access + refresh tokens via
// PKCE, then persists the refresh_token to user_oauth_tokens. This bypasses
// gotrue's azure provider entirely - we never call /me, so accounts whose
// tenant suppresses the email claim (or whose AAD mail attribute is null)
// can connect successfully where gotrue would have 500'd with "Error
// getting user email from external provider". See the design spec for
// the full rationale.
//
// Caller: authenticated Supabase user only. Reads user JWT from the
// Authorization header, verifies via anon client, then uses service-role
// internally to upsert user_oauth_tokens + mail_watchers.
//
// Response:
//   200 { access_token, expires_in } - tokens minted and persisted
//   400 { error: 'invalid-body' }    - missing code / code_verifier / redirect_uri
//   401 { error: 'unauthorized' }    - no/invalid user JWT
//   401 { error: 'invalid-code' }    - Microsoft rejected the auth code
//   502 { error: 'no-refresh-token' }- Microsoft returned 200 with no refresh_token
//                                       (means offline_access scope wasn't granted)
//   400/500 with passthrough for AADSTS errors

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { exchangeAuthorizationCode, RefreshRejectedError } from '../_shared/oauth.ts';

type Body = {
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
  mail_watcher_enabled?: boolean;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) return json({ error: 'missing env' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'unauthorized' }, 401);
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json({ error: 'invalid-body' }, 400); }
  const { code, code_verifier, redirect_uri } = body;
  if (!code || !code_verifier || !redirect_uri) {
    return json({ error: 'invalid-body' }, 400);
  }
  const watcherEnabled = body.mail_watcher_enabled === true;

  let minted;
  try {
    minted = await exchangeAuthorizationCode('microsoft', code, code_verifier, redirect_uri);
  } catch (err) {
    // Raw AADSTS/provider error text stays in the server log only — not the
    // client response (it can carry tenant/policy detail).
    if (err instanceof RefreshRejectedError) {
      console.warn('[microsoft-oauth-exchange] code rejected:', err.message);
      return json({ error: 'invalid-code' }, 401);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[microsoft-oauth-exchange] exchange failed:', msg);
    return json({ error: 'exchange-failed' }, 400);
  }

  if (!minted.rotatedRefreshToken) {
    console.warn('[microsoft-oauth-exchange] no refresh_token in response - offline_access not granted?');
    return json({ error: 'no-refresh-token' }, 502);
  }

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: tokenErr } = await service.from('user_oauth_tokens').upsert(
    {
      user_id: userId,
      provider: 'microsoft',
      refresh_token: minted.rotatedRefreshToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );
  if (tokenErr) {
    // DB error detail (table/constraint names) stays server-side only.
    console.warn('[microsoft-oauth-exchange] persist token failed:', tokenErr.message);
    return json({ error: 'persist-failed' }, 500);
  }

  const { error: watcherErr } = await service.from('mail_watchers').upsert(
    {
      user_id: userId,
      provider: 'microsoft',
      enabled: watcherEnabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );
  if (watcherErr) {
    // Watcher is best-effort - log but don't fail the exchange. The user
    // already has a working refresh token; missing watcher just means cron
    // polling stays off until they re-toggle it in Settings.
    console.warn('[microsoft-oauth-exchange] watcher upsert failed:', watcherErr.message);
  }

  return json({ access_token: minted.accessToken, expires_in: minted.expiresIn });
}

if (import.meta.main) serve(handler);
