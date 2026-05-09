// chat-finalize - closes the loop on a chat_jobs row whose tool execution
// happened client-side (Pass 1's needs_tools branch).
//
// Pass 1 split chat turns: round 0 went through chat-run (server-side, can
// push if backgrounded), but if the model wanted tools, the client took
// over and ran rounds 1..N locally. The job row stayed in `needs_tools`,
// no push fired, no foreground reconciler entry - if the user backgrounded
// mid-tool-loop, even a successful local completion was invisible past
// iOS's 30-second grace window.
//
// This function takes the final assistant text from the client after the
// local loop finishes and does what chat-run does on the no-tool path:
// marks the row done + writes output_text + fires the push. The push is
// the value-add for tool turns that complete within iOS background grace
// (typical "what's in my mail" case is two rounds + Gmail call, 10-20s).
//
// Pass 2 (port the tool loop server-side) will replace this with a
// loop-internal finish; until then, this is the missing piece.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

type FinalizeRequest = {
  jobId: string;
  finalText: string;
  // Used as the push body prefix so the user sees what they asked.
  // Optional; we fall back to just the answer.
  userPreview?: string;
};

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    console.error('[chat-finalize] missing env');
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
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;

  let body: FinalizeRequest;
  try {
    body = (await req.json()) as FinalizeRequest;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (typeof body.jobId !== 'string' || typeof body.finalText !== 'string') {
    return json({ error: 'jobId and finalText are required' }, 400);
  }

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify ownership. The chat_jobs row is RLS-readable by the user via
  // their JWT, but we want the service-role check on the same record so
  // a malformed payload can't make us push something we shouldn't. Also
  // gates the status: only a needs_tools row should be finalised this way;
  // already-done rows are no-ops to keep the call idempotent (a retry
  // shouldn't double-push).
  const { data: job, error: readErr } = await service
    .from('chat_jobs')
    .select('id, user_id, status, acknowledged_at')
    .eq('id', body.jobId)
    .maybeSingle();
  if (readErr || !job) {
    return json({ error: 'job not found' }, 404);
  }
  if ((job as { user_id: string }).user_id !== userId) {
    return json({ error: 'forbidden' }, 403);
  }
  const status = (job as { status: string }).status;
  if (status === 'done') {
    // Already finalised by a prior call (e.g. retry). Don't re-push.
    return json({ jobId: body.jobId, status: 'already-done' });
  }
  if (status !== 'needs_tools' && status !== 'running') {
    // error rows shouldn't be promoted to done from this path.
    return json({ error: `cannot finalize from status=${status}` }, 409);
  }

  // Mark done + write output. finished_at is the ground truth for
  // "answer landed"; the foreground reconciler reads it.
  const { error: updateErr } = await service
    .from('chat_jobs')
    .update({
      status: 'done',
      output_text: body.finalText,
      finished_at: new Date().toISOString(),
    })
    .eq('id', body.jobId);
  if (updateErr) {
    console.error(`[chat-finalize] update failed user=${userId} job=${body.jobId} err=${updateErr.message}`);
    return json({ error: 'update_failed' }, 500);
  }

  // Skip push if the client already acked - means the live UI displayed
  // the answer in-band and a tray banner now would be a duplicate. The
  // foreground notification handler also dedupes via the in-memory ack
  // set, but checking here saves the push round-trip for the foregrounded
  // case.
  if ((job as { acknowledged_at: string | null }).acknowledged_at == null) {
    await sendChatPush(service, userId, body.jobId, body.userPreview ?? null, body.finalText);
  }

  return json({ jobId: body.jobId, status: 'done' });
});

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
    console.warn('[chat-finalize] push send failed', err);
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
