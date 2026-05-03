// supabase/functions/icloud-creds-revoke/index.ts
//
// Hard-deletes the calling user's iCloud creds row. Audited; no payload.
// Called when:
//   - User disconnects iCloud in Settings.
//   - User rotates their app-specific password (client clears + relinks).
//   - Auth-failed signal from voice path (post-link, server-side).
//
// Deploy with `--no-verify-jwt`: ES256 keys, manual JWKS verify.
//
// No iat-freshness gate: revoke is destructive but in the user's interest.
// Aggressive rate limit still applies — a fast revoke loop is a sign of a
// bug or attack.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'https://esm.sh/jose@5.9.6';

const JWKS_URL = new URL('https://auth.zolva.io/auth/v1/.well-known/jwks.json');
let jwks = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60 * 1000,
});

const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX = 5; // five revokes per minute is plenty for human use

type RevokeResponse =
  | { ok: true }
  | { ok: false; code: 'rate_limited' | 'unauthorized' | 'server_error' };

const json = (status: number, body: RevokeResponse): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function verifyJwt(token: string): Promise<{ userId: string }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks));
  } catch {
    jwks = createRemoteJWKSet(JWKS_URL, {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000,
    });
    ({ payload } = await jwtVerify(token, jwks));
  }
  if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
  return { userId: payload.sub };
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(null, { status: 405 });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return json(401, { ok: false, code: 'unauthorized' });

  let userId: string;
  try {
    ({ userId } = await verifyJwt(token));
  } catch {
    return json(401, { ok: false, code: 'unauthorized' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.error('[icloud-creds-revoke] missing env');
    return json(500, { ok: false, code: 'server_error' });
  }
  const client = createClient(supabaseUrl, serviceKey);

  // Rate limit
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_SEC * 1000).toISOString();
  const { count, error: rateErr } = await client
    .from('icloud_calendar_creds_audit')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('event', 'revoke')
    .gte('called_at', windowStart);
  if (rateErr) {
    console.error('[icloud-creds-revoke] rate query failed:', rateErr.message);
    return json(500, { ok: false, code: 'server_error' });
  }
  if ((count ?? 0) >= RATE_LIMIT_MAX) {
    await client.from('icloud_calendar_creds_audit').insert({
      user_id: userId,
      event: 'rate_limited',
    });
    return json(429, { ok: false, code: 'rate_limited' });
  }

  // Hard delete. Idempotent — deleting a non-existent row is a no-op +
  // returns no error. We always log a 'revoke' audit row regardless,
  // because "user explicitly clicked disconnect with no row" is still
  // useful signal.
  const { error: delErr } = await client
    .from('user_icloud_calendar_creds')
    .delete()
    .eq('user_id', userId);
  if (delErr) {
    console.error('[icloud-creds-revoke] delete failed:', delErr.message);
    return json(500, { ok: false, code: 'server_error' });
  }

  await client.from('icloud_calendar_creds_audit').insert({
    user_id: userId,
    event: 'revoke',
  });

  console.log(JSON.stringify({ kind: 'icloud-creds-revoke', user_id: userId, success: true }));
  return json(200, { ok: true });
});
