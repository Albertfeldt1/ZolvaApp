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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  loadRefreshToken,
  refreshAccessToken,
  RefreshRejectedError,
} from '../_shared/oauth.ts';

type Body = { provider?: 'google' | 'microsoft' };

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
    const result = await refreshAccessToken(client, userId, provider, refreshToken, {
      microsoftScope: MICROSOFT_REFRESH_SCOPE,
    });
    return json({ access_token: result.accessToken, expires_in: result.expiresIn });
  } catch (err) {
    if (err instanceof RefreshRejectedError) {
      console.warn('[refresh-provider-token] rejected:', provider, err.message);
      return json({ error: 'refresh-rejected' }, 401);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[refresh-provider-token] failed:', provider, msg);
    return json({ error: msg }, 500);
  }
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
