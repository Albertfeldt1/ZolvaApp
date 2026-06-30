// transcribe-proxy - Supabase Edge Function.
//
// Forwards an uploaded audio recording to OpenAI's /v1/audio/transcriptions
// using the server-side OPENAI_API_KEY, and returns the Danish transcript.
// Mirrors claude-proxy: the caller presents a Supabase user JWT which we
// re-validate via supabase-js (the gateway can't verify the project's ES256
// tokens, so deploy with --no-verify-jwt). We enforce the same per-user
// anti-abuse limiter so a leaked token can't run up the shared OpenAI key.
//
// Request: multipart/form-data with a single `file` field (the audio blob).
// Optional `language` field (defaults to "da").
// Response: { text: string }
//
// We log only metadata (user_id, bytes, duration) — never the transcript.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getEntitlement } from '../_shared/entitlement-read.ts';
import { dailyRequestCapForTier, RPM_LIMIT } from '../_shared/abuse-limits.ts';

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
// whisper-1 is the cheapest widely-available model ($0.006/min) with solid
// Danish. Override via OPENAI_TRANSCRIBE_MODEL (e.g. gpt-4o-transcribe).
const DEFAULT_MODEL = 'whisper-1';
// Reject oversized uploads before touching OpenAI. ~25MB is OpenAI's own limit;
// a few minutes of compressed audio is well under this.
const MAX_BYTES = 25 * 1024 * 1024;

serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!supabaseUrl || !anonKey || !openaiKey) {
    console.error('[transcribe-proxy] missing env (supabaseUrl/anonKey/openaiKey)');
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

  // Same tier-aware limiter as claude-proxy. For v1 transcription shares the
  // chat daily ceiling — a reasonable abuse guard; split into its own counter
  // when we add per-tier usage caps + buy-extra (see project notes).
  const ent = await getEntitlement(authClient, userId);
  const { data: limitRows, error: limitErr } = await authClient.rpc('check_and_incr_claude_usage', {
    p_user_id: userId,
    p_rpm_limit: RPM_LIMIT,
    p_daily_limit: dailyRequestCapForTier(ent.tier),
  });
  if (limitErr) {
    console.error(`[transcribe-proxy] rate_limit_check_failed user=${userId} err=${limitErr.message}`);
    return json({ error: 'rate limit check failed' }, 500);
  }
  const limit = Array.isArray(limitRows) ? limitRows[0] : limitRows;
  if (!limit?.allowed) {
    const retryAfter = Math.max(1, Number(limit?.retry_after ?? 60));
    const reason = String(limit?.reason ?? 'rpm');
    console.warn(`[transcribe-proxy] rate_limited user=${userId} reason=${reason}`);
    return new Response(JSON.stringify({ error: `rate_limit_${reason}`, retry_after: retryAfter }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
    });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'expected multipart/form-data' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return json({ error: 'missing file field' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: 'file too large' }, 413);
  }
  const language = (form.get('language') as string | null) ?? 'da';
  const model = Deno.env.get('OPENAI_TRANSCRIBE_MODEL') ?? DEFAULT_MODEL;

  const openaiForm = new FormData();
  openaiForm.append('file', file, file.name || 'audio.m4a');
  openaiForm.append('model', model);
  openaiForm.append('language', language);
  // Plain text response keeps parsing trivial; we only want the transcript.
  openaiForm.append('response_format', 'text');

  let openaiRes: Response;
  try {
    openaiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: openaiForm,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[transcribe-proxy] openai_fetch_failed user=${userId} err=${msg}`);
    return json({ error: 'upstream unreachable' }, 502);
  }

  const responseText = await openaiRes.text();
  if (!openaiRes.ok) {
    console.warn(`[transcribe-proxy] openai_error status=${openaiRes.status} user=${userId}`);
    return json({ error: 'transcription failed', status: openaiRes.status }, 502);
  }

  console.log(`[transcribe-proxy] ok user=${userId} bytes=${file.size} model=${model}`);
  return json({ text: responseText.trim() }, 200);
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
