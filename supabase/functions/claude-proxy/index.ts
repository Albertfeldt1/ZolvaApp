// claude-proxy — Supabase Edge Function.
//
// Forwards chat-completion requests to Anthropic's /v1/messages using the
// server-side ANTHROPIC_API_KEY. The caller must present a valid Supabase
// user JWT — the function is deployed WITHOUT --no-verify-jwt, and it also
// re-checks the user via supabase-js so logs can be tied to a user_id.
//
// Request body shape (matches what src/lib/claude.ts sends):
//   { messages, model?, max_tokens?, system?, temperature?, tools? }
//
// We log only metadata (user_id, model, token usage) — never the prompt or
// completion text.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

type Message = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

type ProxyRequest = {
  messages: Message[];
  model?: string;
  max_tokens?: number;
  system?: string;
  temperature?: number;
  tools?: unknown[];
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;

serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !anonKey || !anthropicKey) {
    console.error('[claude-proxy] missing env (supabaseUrl/anonKey/anthropicKey)');
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

  let body: ProxyRequest;
  try {
    body = (await req.json()) as ProxyRequest;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'messages is required and must be a non-empty array' }, 400);
  }

  const model = body.model ?? DEFAULT_MODEL;
  const maxTokens = body.max_tokens ?? DEFAULT_MAX_TOKENS;

  const anthropicBody: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: body.messages,
    metadata: { user_id: userId },
  };
  if (body.system != null) anthropicBody.system = body.system;
  if (body.temperature != null) anthropicBody.temperature = body.temperature;
  if (body.tools != null) anthropicBody.tools = body.tools;

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[claude-proxy] anthropic_fetch_failed user=${userId} model=${model} err=${msg}`);
    return json({ error: 'upstream unreachable' }, 502);
  }

  const responseText = await anthropicRes.text();

  if (anthropicRes.ok) {
    const usage = tryReadUsage(responseText);
    console.log(
      `[claude-proxy] ok user=${userId} model=${model} in=${usage.input ?? '?'} out=${usage.output ?? '?'}`,
    );
  } else {
    console.warn(
      `[claude-proxy] anthropic_error status=${anthropicRes.status} user=${userId} model=${model}`,
    );
  }

  return new Response(responseText, {
    status: anthropicRes.status,
    headers: { 'content-type': 'application/json' },
  });
});

function tryReadUsage(raw: string): { input?: number; output?: number } {
  try {
    const parsed = JSON.parse(raw) as {
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return { input: parsed.usage?.input_tokens, output: parsed.usage?.output_tokens };
  } catch {
    return {};
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
