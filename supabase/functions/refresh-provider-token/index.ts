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

type EdgeOutcome =
  | 'success'
  | 'method_not_allowed'
  | 'missing_env'
  | 'unauthorized'
  | 'invalid_body'
  | 'invalid_provider'
  | 'no_refresh_token'
  | 'refresh_rejected'
  | 'failed';

// Note: a successful refresh emits TWO [oauth-refresh] lines — one from
// oauth.ts (no `layer` field) and one from this edge handler
// (layer: 'edge'). When grepping logs, distinguish by the `layer` field.
// Expect ~2x line count vs. request count for the success path.
function emitEdgeLog(fields: {
  provider: string | null;
  userId: string | null;
  outcome: EdgeOutcome;
  status: number;
  elapsedMs: number;
  errorMessage?: string;
}): void {
  console.log(
    '[oauth-refresh]',
    JSON.stringify({ layer: 'edge', source: 'refresh-provider-token', ...fields }),
  );
}

serve(async (req) => {
  const startedAt = Date.now();
  let provider: string | null = null;
  let userId: string | null = null;
  const finish = (outcome: EdgeOutcome, status: number, errorMessage?: string) => {
    emitEdgeLog({
      provider,
      userId,
      outcome,
      status,
      elapsedMs: Date.now() - startedAt,
      errorMessage,
    });
  };

  if (req.method !== 'POST') {
    finish('method_not_allowed', 405);
    return json({ error: 'method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) {
    finish('missing_env', 500);
    return json({ error: 'missing env' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    finish('unauthorized', 401);
    return json({ error: 'unauthorized' }, 401);
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) {
    finish('unauthorized', 401);
    return json({ error: 'unauthorized' }, 401);
  }
  userId = userData.user.id.slice(0, 8);
  const fullUserId = userData.user.id;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    finish('invalid_body', 400);
    return json({ error: 'invalid body' }, 400);
  }
  const providerRaw = body.provider;
  if (providerRaw !== 'google' && providerRaw !== 'microsoft') {
    finish('invalid_provider', 400);
    return json({ error: 'invalid provider' }, 400);
  }
  provider = providerRaw;

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const refreshToken = await loadRefreshToken(client, fullUserId, providerRaw);
  if (!refreshToken) {
    finish('no_refresh_token', 404);
    return json({ error: 'no-refresh-token' }, 404);
  }

  try {
    const result = await refreshAccessToken(client, fullUserId, providerRaw, refreshToken, {
      microsoftScope: MICROSOFT_REFRESH_SCOPE,
    });
    finish('success', 200);
    return json({ access_token: result.accessToken, expires_in: result.expiresIn });
  } catch (err) {
    if (err instanceof RefreshRejectedError) {
      finish('refresh_rejected', 401, err.message);
      return json({ error: 'refresh-rejected' }, 401);
    }
    const msg = err instanceof Error ? err.message : String(err);
    finish('failed', 500, msg);
    return json({ error: msg }, 500);
  }
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
