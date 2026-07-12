// tts-proxy - Supabase Edge Function.
//
// Turns a short text (a chat reply) into speech via OpenAI's /v1/audio/speech
// using the server-side OPENAI_API_KEY, and returns the mp3 as base64 JSON —
// React Native has no reliable binary fetch body handling, so base64 keeps
// the client trivial (write string → play file).
//
// Mirrors transcribe-proxy: the caller presents a Supabase user JWT which we
// re-validate via supabase-js (the gateway can't verify the project's ES256
// tokens, so deploy with --no-verify-jwt). Same per-user anti-abuse limiter
// so a leaked token can't run up the shared OpenAI key.
//
// Request: JSON { text: string }
// Response: { audio_b64: string, mime: "audio/mpeg" }
//
// We log only metadata (user_id, chars) — never the text itself.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getEntitlement } from '../_shared/entitlement-read.ts';
import { dailyRequestCapForTier, RPM_LIMIT } from '../_shared/abuse-limits.ts';

const OPENAI_URL = 'https://api.openai.com/v1/audio/speech';
// gpt-4o-mini-tts: solid dansk udtale + styrbar tone via `instructions`.
// Override via OPENAI_TTS_MODEL (fx tts-1) / OPENAI_TTS_VOICE.
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'nova';
// OpenAI's own input limit is 4096 chars; chat replies are well under this.
const MAX_CHARS = 4096;

serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!supabaseUrl || !anonKey || !openaiKey) {
    console.error('[tts-proxy] missing env (supabaseUrl/anonKey/openaiKey)');
    return json({ error: 'server misconfigured' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'missing bearer token' }, 401);
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) {
    return json({ error: 'unauthorized' }, 401);
  }
  const userId = userData.user.id;

  // Same tier-aware limiter as claude-proxy/transcribe-proxy — TTS shares the
  // daily request ceiling rather than getting its own counter.
  const ent = await getEntitlement(authClient, userId);
  const { data: limitRows, error: limitErr } = await authClient.rpc('check_and_incr_claude_usage', {
    p_user_id: userId,
    p_rpm_limit: RPM_LIMIT,
    p_daily_limit: dailyRequestCapForTier(ent.tier),
  });
  if (limitErr) {
    console.error(`[tts-proxy] rate_limit_check_failed user=${userId} err=${limitErr.message}`);
    return json({ error: 'rate limit check failed' }, 500);
  }
  const limit = Array.isArray(limitRows) ? limitRows[0] : limitRows;
  if (!limit?.allowed) {
    const retryAfter = Math.max(1, Number(limit?.retry_after ?? 60));
    const reason = String(limit?.reason ?? 'rpm');
    console.warn(`[tts-proxy] rate_limited user=${userId} reason=${reason}`);
    return new Response(JSON.stringify({ error: `rate_limit_${reason}`, retry_after: retryAfter }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
    });
  }

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'expected json body' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return json({ error: 'missing text' }, 400);
  }
  const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;

  const model = Deno.env.get('OPENAI_TTS_MODEL') ?? DEFAULT_MODEL;
  const voice = Deno.env.get('OPENAI_TTS_VOICE') ?? DEFAULT_VOICE;
  const payload: Record<string, unknown> = { model, voice, input, response_format: 'mp3' };
  // `instructions` is only accepted by the gpt-4o-* TTS models; tts-1 rejects it.
  if (model.startsWith('gpt-')) {
    payload.instructions =
      'Tal dansk. Naturligt tempo, venlig og rolig tone — som en personlig assistent der læser sit svar op.';
  }

  let openaiRes: Response;
  try {
    openaiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tts-proxy] openai_fetch_failed user=${userId} err=${msg}`);
    return json({ error: 'upstream unreachable' }, 502);
  }

  if (!openaiRes.ok) {
    console.warn(`[tts-proxy] openai_error status=${openaiRes.status} user=${userId}`);
    return json({ error: 'speech synthesis failed', status: openaiRes.status }, 502);
  }

  const bytes = new Uint8Array(await openaiRes.arrayBuffer());
  console.log(`[tts-proxy] ok user=${userId} chars=${input.length} bytes=${bytes.length} model=${model}`);
  return json({ audio_b64: encodeBase64(bytes), mime: 'audio/mpeg' }, 200);
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
