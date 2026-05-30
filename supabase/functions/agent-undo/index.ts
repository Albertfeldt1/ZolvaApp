// agent-undo - reverse a previously-executed agent_action.
//
// JWT-authenticated only (no cron path; users initiate undos themselves).
// Atomically claims the action via agent_revert_action so a double-tap
// can't double-revert, then applies the reverse_token against the provider.
//
// Supports `gmail.modify` (archive/label/flag) and `gmail.draft` (delete the
// drafted reply) reverse tokens.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import { gmailDeleteDraft, gmailModifyThread } from '../_shared/agent/tools/gmail.ts';
import type { GmailDraftReverseToken, GmailModifyReverseToken } from '../_shared/agent/tools/gmail.ts';

type ReverseToken = GmailModifyReverseToken | GmailDraftReverseToken;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function authenticatedUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await supa.auth.getUser();
  if (error) return null;
  return data.user?.id ?? null;
}

async function applyReverseToken(
  client: SupabaseClient,
  userId: string,
  token: ReverseToken,
): Promise<void> {
  const refresh = await loadRefreshToken(client, userId, 'google');
  if (!refresh) throw new Error('no google refresh token for user');
  const { accessToken } = await refreshAccessToken(client, userId, 'google', refresh);
  if (token.kind === 'gmail.modify') {
    await gmailModifyThread({
      fetch: fetch as never,
      accessToken,
      threadId: token.thread_id,
      addLabelIds: token.add_label_ids,
      removeLabelIds: token.remove_label_ids,
    });
    return;
  }
  if (token.kind === 'gmail.draft') {
    // Undoing a drafted reply = delete the Gmail draft.
    await gmailDeleteDraft({
      fetch: fetch as never,
      accessToken,
      draftId: token.draft_id,
    });
    return;
  }
  throw new Error(`unsupported reverse_token kind ${(token as { kind: string }).kind}`);
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const userId = await authenticatedUserId(req);
  if (!userId) return new Response('unauthorized', { status: 401 });

  let body: { action_id?: string };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const actionId = body.action_id;
  if (!actionId) return new Response('action_id required', { status: 400 });

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data, error } = await client.rpc('agent_revert_action', {
    p_action_id: actionId,
    p_user_id: userId,
  });
  if (error) {
    console.error('[agent-undo] rpc error', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }
  const row = (data ?? [])[0] as
    | { claimed: boolean; action_type: string; reverse_token: ReverseToken | null }
    | undefined;
  if (!row?.claimed) {
    // Either nonexistent, foreign user, already-reverted, or not reversible.
    return new Response(JSON.stringify({ ok: false, reason: 'not_reversible' }), { status: 200 });
  }
  if (!row.reverse_token) {
    return new Response(JSON.stringify({ ok: true, reverted: true, note: 'no-op' }), { status: 200 });
  }
  try {
    await applyReverseToken(client, userId, row.reverse_token);
  } catch (e) {
    // Undo failed against provider — the row is already marked reversed,
    // but the user-visible state is now inconsistent. Surface clearly.
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-undo] provider error', msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 502 });
  }
  return new Response(JSON.stringify({ ok: true, reverted: true }), { status: 200 });
});
