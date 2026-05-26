// chat-run - background-execution worker for chat turns.
//
// Why this exists: the chat loop used to live entirely on the client (see
// useChat in src/lib/hooks.ts). When the user backgrounded the app mid-turn,
// iOS would suspend the JS VM and the in-flight Anthropic call dropped on
// the floor. This function takes the same per-turn payload, runs the model
// server-side, persists the outcome to chat_jobs, and pushes a notification
// when the answer's ready - the user can then leave the app and come back
// to (or be tapped through to) the result.
//
// Pass 1 scope: no-tool turns end to end. If the model returns tool_use
// blocks, we mark the job 'needs_tools' and return them so the client can
// run today's local tool loop. Pass 2 ports tool execution here.
//
// The function is deployed with --no-verify-jwt because Supabase signs
// tokens with ES256 and the gateway only verifies HS256; we re-validate
// the bearer ourselves via supabase-js getUser.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { recordAiUsage } from '../_shared/usage.ts';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
      };
    };

type Message = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

type ClaudeSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type ChatRunRequest = {
  messages: Message[];
  system: string | ClaudeSystemBlock[];
  tools?: unknown[];
  model?: string;
  max_tokens?: number;
  metadata?: Record<string, unknown>;
  // Short preview of the user's last turn, used as the push notification
  // body when the answer arrives. Client-supplied because the function
  // doesn't try to parse the message content shape.
  userPreview?: string;
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;

// Match claude-proxy's per-user caps. The chat-run path is just a different
// shape of the same Anthropic call so it shares the budget; checked via the
// same RPC so RPM/daily are enforced across both.
const RPM_LIMIT = 60;
const DAILY_LIMIT = 500;

serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey || !anthropicKey) {
    console.error('[chat-run] missing env');
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

  // Rate limit before any DB writes - same RPC as claude-proxy so the two
  // paths share one budget per user.
  const { data: limitRows, error: limitErr } = await authClient.rpc(
    'check_and_incr_claude_usage',
    { p_user_id: userId, p_rpm_limit: RPM_LIMIT, p_daily_limit: DAILY_LIMIT },
  );
  if (limitErr) {
    console.error(`[chat-run] rate_limit_check_failed user=${userId} err=${limitErr.message}`);
    return json({ error: 'rate limit check failed' }, 500);
  }
  const limit = Array.isArray(limitRows) ? limitRows[0] : limitRows;
  if (!limit?.allowed) {
    const retryAfter = Math.max(1, Number(limit?.retry_after ?? 60));
    const reason = String(limit?.reason ?? 'rpm');
    return new Response(
      JSON.stringify({ error: `rate_limit_${reason}`, retry_after: retryAfter }),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
      },
    );
  }

  let body: ChatRunRequest;
  try {
    body = (await req.json()) as ChatRunRequest;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'messages is required and must be a non-empty array' }, 400);
  }
  if (body.system == null) {
    return json({ error: 'system is required' }, 400);
  }

  const model = body.model ?? DEFAULT_MODEL;
  const maxTokens = body.max_tokens ?? DEFAULT_MAX_TOKENS;

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Insert the job row up front so we always have something to attach the
  // outcome to - even if the Anthropic call throws or the function times
  // out, the row carries enough state for the foreground reconciler to do
  // something sensible (mark it as error, retry on user resend, etc.).
  const insertPayload = {
    user_id: userId,
    status: 'running' as const,
    input_messages: body.messages,
    system_prompt: body.system,
    tools: body.tools ?? null,
    metadata: body.metadata ?? null,
  };
  const { data: jobRow, error: insertErr } = await service
    .from('chat_jobs')
    .insert(insertPayload)
    .select('id')
    .single();
  if (insertErr || !jobRow) {
    console.error(`[chat-run] job_insert_failed user=${userId} err=${insertErr?.message}`);
    return json({ error: 'job_insert_failed' }, 500);
  }
  const jobId = jobRow.id as string;

  // Forward to Anthropic with the same payload shape claude-proxy uses.
  // System block whitelist is duplicated here on purpose - the body crossed
  // an untrusted JSON boundary so we re-emit only the fields we expect.
  const anthropicBody: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: body.messages,
    metadata: { user_id: userId },
  };
  if (Array.isArray(body.system)) {
    anthropicBody.system = body.system
      .filter((b): b is ClaudeSystemBlock =>
        !!b && typeof b === 'object' &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => {
        const block: Record<string, unknown> = { type: 'text', text: b.text };
        if (b.cache_control?.type === 'ephemeral') {
          block.cache_control = { type: 'ephemeral' };
        }
        return block;
      });
  } else {
    anthropicBody.system = [{ type: 'text', text: body.system }];
  }
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
    console.warn(`[chat-run] anthropic_fetch_failed user=${userId} job=${jobId} err=${msg}`);
    await markJob(service, jobId, { status: 'error', error_code: 'upstream_unreachable' });
    return json({ error: 'upstream unreachable', jobId }, 502);
  }

  if (!anthropicRes.ok) {
    console.warn(`[chat-run] anthropic_error status=${anthropicRes.status} user=${userId} job=${jobId}`);
    await markJob(service, jobId, { status: 'error', error_code: `anthropic_${anthropicRes.status}` });
    const errText = await anthropicRes.text();
    return new Response(errText, {
      status: anthropicRes.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const responseText = await anthropicRes.text();
  let parsed: { content?: ContentBlock[]; usage?: { input_tokens?: number; output_tokens?: number } };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    await markJob(service, jobId, { status: 'error', error_code: 'parse_failed' });
    return json({ error: 'parse_failed', jobId }, 502);
  }

  // Token accounting (best effort - same as claude-proxy).
  if (parsed.usage?.input_tokens != null || parsed.usage?.output_tokens != null) {
    authClient
      .rpc('record_claude_tokens', {
        p_user_id: userId,
        p_input_tokens: parsed.usage?.input_tokens ?? 0,
        p_output_tokens: parsed.usage?.output_tokens ?? 0,
      })
      .then(({ error }) => {
        if (error) console.warn(`[chat-run] token_record_failed user=${userId} err=${error.message}`);
      });
    void recordAiUsage(authClient, userId, 'chat-run', model, parsed.usage);
  }

  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  const toolUses = blocks.filter((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use');
  const text = blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Tool branch: short-circuit. Pass 2 will continue the loop server-side.
  if (toolUses.length > 0) {
    await markJob(service, jobId, {
      status: 'needs_tools',
      tool_uses: toolUses,
      output_text: text || null,
    });
    return json({
      jobId,
      status: 'needs_tools',
      toolUses,
      rawContent: blocks,
      text,
    });
  }

  // Pure text answer - the happy path for backgrounded turns.
  await markJob(service, jobId, { status: 'done', output_text: text });
  await sendChatPush(service, userId, jobId, body.userPreview ?? null, text);

  return json({ jobId, status: 'done', text });
});

async function markJob(
  client: SupabaseClient,
  jobId: string,
  patch: {
    status: 'done' | 'needs_tools' | 'error';
    output_text?: string | null;
    tool_uses?: unknown;
    error_code?: string;
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    status: patch.status,
    finished_at: new Date().toISOString(),
  };
  if (patch.output_text !== undefined) update.output_text = patch.output_text;
  if (patch.tool_uses !== undefined) update.tool_uses = patch.tool_uses;
  if (patch.error_code !== undefined) update.error_code = patch.error_code;
  const { error } = await client.from('chat_jobs').update(update).eq('id', jobId);
  if (error) console.warn(`[chat-run] markJob failed job=${jobId} err=${error.message}`);
}

// Push the answer headline to the user's devices. Best effort - failure
// just means the user won't see a tray notification; the row's still in
// the DB so the foreground reconciler picks it up next time the app opens.
async function sendChatPush(
  client: SupabaseClient,
  userId: string,
  jobId: string,
  userPreview: string | null,
  answer: string,
): Promise<void> {
  const { data: tokens } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  if (!tokens || tokens.length === 0) return;

  const title = 'Zolva har svaret';
  // Body shape: prefix with the user's question (truncated) so the answer
  // has context in the tray. iOS/Android show the first line in the
  // collapsed banner; the expanded view shows both.
  const preview = answer.length > 180 ? answer.slice(0, 177).trimEnd() + '…' : answer;
  const body = userPreview
    ? `Du spurgte: "${truncate(userPreview, 60)}"\n\n${preview}`
    : preview;

  const messages = tokens.map((t) => ({
    to: (t as Record<string, string>).token,
    title,
    body,
    sound: 'default',
    data: { type: 'chatReply', jobId },
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.warn('[chat-run] push send failed', err);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
