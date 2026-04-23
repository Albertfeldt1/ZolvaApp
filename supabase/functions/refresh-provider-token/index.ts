// refresh-provider-token — Supabase Edge Function (user-scoped).
//
// Exchanges the user's stored OAuth refresh_token for a fresh access_token
// by POSTing to the provider's token endpoint with the server-held
// client_secret. Keeps OAuth secrets off the device and — critically —
// keeps ASWebAuthenticationSession out of the hot path, so iOS stops
// showing its "Zolva wants to use supabase.co to sign you in" dialog
// every time provider tokens age out (~hourly).
//
// Caller: authenticated user only. Reads user JWT from Authorization
// header, verifies via anon client, then uses service-role internally
// to pull the refresh_token row. No cron path — this is per-user.
//
// Response:
//   200 { access_token, expires_in }  — fresh token ready to use
//   401 { error: 'unauthorized' }      — no/invalid user JWT
//   401 { error: 'refresh-rejected' }  — provider rejected the refresh_token
//                                        (user needs full re-auth)
//   404 { error: 'no-refresh-token' }  — no stored grant for this user+provider
//   400/500 otherwise

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

type Body = { provider?: 'google' | 'microsoft' };
type RefreshResult = {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
};

const MICROSOFT_REFRESH_SCOPE =
  'openid email profile offline_access Mail.ReadWrite Mail.Send Calendars.Read';

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ error: 'missing env' }, 500);
  }

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
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: 'invalid body' }, 400);
  }
  const provider = body.provider;
  if (provider !== 'google' && provider !== 'microsoft') {
    return json({ error: 'invalid provider' }, 400);
  }

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const refreshToken = await loadRefreshToken(client, userId, provider);
  if (!refreshToken) return json({ error: 'no-refresh-token' }, 404);

  try {
    const result = await refreshAccessToken(provider, refreshToken);
    // Some providers (Google occasionally, Microsoft sometimes) rotate the
    // refresh_token on refresh. Persist the new one if returned so the next
    // refresh doesn't fail with invalid_grant.
    if (result.refreshToken && result.refreshToken !== refreshToken) {
      await persistRefreshToken(client, userId, provider, result.refreshToken);
    }
    return json({ access_token: result.accessToken, expires_in: result.expiresIn });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[refresh-provider-token] provider rejected:', provider, msg);
    // Distinguish provider rejection (refresh_token no longer valid — user
    // must re-auth through full OAuth) from transient errors.
    if (/invalid_grant|400/.test(msg)) {
      return json({ error: 'refresh-rejected' }, 401);
    }
    return json({ error: msg }, 500);
  }
});

async function loadRefreshToken(
  client: SupabaseClient,
  userId: string,
  provider: 'google' | 'microsoft',
): Promise<string | null> {
  const { data, error } = await client
    .from('user_oauth_tokens')
    .select('refresh_token')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) {
    console.warn('[refresh-provider-token] load refresh token failed:', error.message);
    return null;
  }
  return (data as { refresh_token?: string } | null)?.refresh_token ?? null;
}

async function persistRefreshToken(
  client: SupabaseClient,
  userId: string,
  provider: 'google' | 'microsoft',
  refreshToken: string,
): Promise<void> {
  const { error } = await client
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
  if (error) {
    console.warn('[refresh-provider-token] persist refresh token failed:', error.message);
  }
}

async function refreshAccessToken(
  provider: 'google' | 'microsoft',
  refreshToken: string,
): Promise<RefreshResult> {
  if (provider === 'google') {
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !clientSecret) throw new Error('google oauth env missing');
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`google refresh ${res.status}: ${text}`);
    const j = JSON.parse(text) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!j.access_token) throw new Error('google refresh missing access_token');
    return {
      accessToken: j.access_token,
      expiresIn: j.expires_in ?? 3600,
      refreshToken: j.refresh_token,
    };
  }

  const clientId = Deno.env.get('MICROSOFT_OAUTH_CLIENT_ID');
  const clientSecret = Deno.env.get('MICROSOFT_OAUTH_CLIENT_SECRET');
  const tenant = Deno.env.get('MICROSOFT_OAUTH_TENANT') ?? 'common';
  if (!clientId || !clientSecret) throw new Error('microsoft oauth env missing');
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: MICROSOFT_REFRESH_SCOPE,
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`microsoft refresh ${res.status}: ${text}`);
  const j = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!j.access_token) throw new Error('microsoft refresh missing access_token');
  return {
    accessToken: j.access_token,
    expiresIn: j.expires_in ?? 3600,
    refreshToken: j.refresh_token,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
