// supabase/functions/icloud-creds-link/index.ts
//
// Receives an iCloud Apple ID + app-specific password + pre-discovered
// calendar-home URL from the authenticated client, encrypts via pgcrypto,
// upserts into user_icloud_calendar_creds.
//
// Deploy with `--no-verify-jwt`: project uses ES256 keys which the
// Supabase gateway can't verify; we verify manually with JWKS.
//
// Threat model + reauth-gate caveats live in the table migration header
// (20260429140000_icloud_calendar_creds.sql). Read it before changing
// anything in this file.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'https://esm.sh/jose@5.9.6';

// JWKS verification — duplicated from widget-action/jwt.ts intentionally.
// Refactor to _shared/jwt.ts in Phase 2 when widget-action is touched anyway.
const PROJECT_REF = 'sjkhfkatmeqtsrysixop';
const JWKS_URL = new URL(`https://${PROJECT_REF}.supabase.co/auth/v1/.well-known/jwks.json`);
let jwks = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60 * 1000,
});

const IAT_FRESHNESS_WINDOW_SEC = 5 * 60;
const RATE_LIMIT_WINDOW_SEC = 5 * 60;
const RATE_LIMIT_MAX = 1; // one link per 5min per user

type LinkRequest = {
  email?: string;
  password?: string;
  calendar_home_url?: string;
};

type LinkResponse =
  | { ok: true }
  | { ok: false; code: 'reauth_required' | 'rate_limited' | 'invalid_request' | 'unauthorized' | 'server_error' };

const json = (status: number, body: LinkResponse): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function verifyJwt(token: string): Promise<{ userId: string; iat: number }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks));
  } catch {
    // One-shot JWKS refresh + retry on rotation.
    jwks = createRemoteJWKSet(JWKS_URL, {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000,
    });
    ({ payload } = await jwtVerify(token, jwks));
  }
  if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
  if (typeof payload.iat !== 'number') throw new Error('jwt missing iat');
  return { userId: payload.sub, iat: payload.iat };
}

function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;
}

function isValidPassword(s: unknown): s is string {
  // Apple app-specific passwords are 16 chars in 4-4-4-4 format with dashes,
  // but accept up to 64 to allow legacy formats and a small safety margin.
  return typeof s === 'string' && s.length >= 8 && s.length <= 64;
}

function isValidUrl(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 512) return false;
  try {
    const u = new URL(s);
    // Must be Apple's CalDAV; reject anything else to limit blast radius.
    return u.protocol === 'https:' && u.hostname.endsWith('caldav.icloud.com');
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return json(405, { ok: false, code: 'invalid_request' });
  }

  // 1) Authn
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return json(401, { ok: false, code: 'unauthorized' });

  let userId: string;
  let iat: number;
  try {
    ({ userId, iat } = await verifyJwt(token));
  } catch {
    return json(401, { ok: false, code: 'unauthorized' });
  }

  // 2) Parse body before audit/rate so a malformed body doesn't waste a
  //    rate-limit slot.
  let body: LinkRequest;
  try {
    body = (await req.json()) as LinkRequest;
  } catch {
    return json(400, { ok: false, code: 'invalid_request' });
  }
  if (
    !isValidEmail(body.email) ||
    !isValidPassword(body.password) ||
    !isValidUrl(body.calendar_home_url)
  ) {
    return json(400, { ok: false, code: 'invalid_request' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const encryptionKey = Deno.env.get('ICLOUD_CREDS_ENCRYPTION_KEY');
  if (!supabaseUrl || !serviceKey || !encryptionKey) {
    console.error('[icloud-creds-link] missing env');
    return json(500, { ok: false, code: 'server_error' });
  }
  const client = createClient(supabaseUrl, serviceKey);

  // 3) iat freshness gate. Audit the failure so we can detect anomalies.
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - iat > IAT_FRESHNESS_WINDOW_SEC) {
    await client.from('icloud_calendar_creds_audit').insert({
      user_id: userId,
      event: 'reauth_required',
    });
    return json(401, { ok: false, code: 'reauth_required' });
  }

  // 4) Rate limit. Window query against audit log.
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_SEC * 1000).toISOString();
  const { count, error: rateErr } = await client
    .from('icloud_calendar_creds_audit')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('event', 'link')
    .gte('called_at', windowStart);
  if (rateErr) {
    console.error('[icloud-creds-link] rate query failed:', rateErr.message);
    return json(500, { ok: false, code: 'server_error' });
  }
  if ((count ?? 0) >= RATE_LIMIT_MAX) {
    await client.from('icloud_calendar_creds_audit').insert({
      user_id: userId,
      event: 'rate_limited',
    });
    return json(429, { ok: false, code: 'rate_limited' });
  }

  // 5) Encrypt + upsert. Plaintext JSON is fed into pgp_sym_encrypt; the
  //    edge function holds the key from env, never persists it.
  const plaintext = JSON.stringify({
    email: body.email,
    password: body.password,
    calendar_home_url: body.calendar_home_url,
  });
  const { data: encryptedRow, error: encErr } = await client.rpc('encrypt_icloud_creds', {
    plaintext_json: plaintext,
    encryption_key: encryptionKey,
  });
  if (encErr || encryptedRow == null) {
    console.error('[icloud-creds-link] encrypt failed:', encErr?.message);
    return json(500, { ok: false, code: 'server_error' });
  }

  const { error: upsertErr } = await client
    .from('user_icloud_calendar_creds')
    .upsert({ user_id: userId, encrypted_blob: encryptedRow }, { onConflict: 'user_id' });
  if (upsertErr) {
    console.error('[icloud-creds-link] upsert failed:', upsertErr.message);
    return json(500, { ok: false, code: 'server_error' });
  }

  await client.from('icloud_calendar_creds_audit').insert({
    user_id: userId,
    event: 'link',
  });

  console.log(JSON.stringify({ kind: 'icloud-creds-link', user_id: userId, success: true }));
  return json(200, { ok: true });
});
