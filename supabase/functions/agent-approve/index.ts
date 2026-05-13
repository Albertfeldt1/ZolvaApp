// agent-approve - execute a pending proposed_action on user approval.
//
// JWT-authenticated only. Reads the proposed_actions row by id, verifies
// ownership + status='pending' + not expired, dispatches the action via
// the same tool catalog the runner uses, transitions the proposal row.
//
// Handles both Phase 3 drafts (mail.send_reply) and Phase 3.1 deferred-
// execute proposals (mail.archive / mail.label / mail.flag_important when
// the user's policy is `propose`).

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import { resolveLabelId } from '../_shared/agent/tools/gmail.ts';
import { executeTool, type ExecuteContext } from '../_shared/agent/tools/dispatch.ts';
import type { ActionType } from '../_shared/agent/types.ts';

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

async function loadGmailToken(client: SupabaseClient, userId: string): Promise<string> {
  const r = await loadRefreshToken(client, userId, 'google');
  if (!r) throw new Error('no google refresh token');
  const { accessToken } = await refreshAccessToken(client, userId, 'google', r);
  return accessToken;
}

async function loadOutlookToken(client: SupabaseClient, userId: string): Promise<string> {
  const r = await loadRefreshToken(client, userId, 'microsoft');
  if (!r) throw new Error('no microsoft refresh token');
  const { accessToken } = await refreshAccessToken(client, userId, 'microsoft', r);
  return accessToken;
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const userId = await authenticatedUserId(req);
  if (!userId) return new Response('unauthorized', { status: 401 });

  let body: { action_id?: string; edited_body?: string };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const actionId = body.action_id;
  if (!actionId) return new Response('action_id required', { status: 400 });

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Atomic transition: pending → approved, only if not expired and owned by caller.
  const { data: claimed, error: claimErr } = await client
    .from('proposed_actions')
    .update({ status: 'approved', decided_at: new Date().toISOString() })
    .eq('id', actionId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .select('id, run_id, action_type, payload')
    .maybeSingle();
  if (claimErr) {
    console.error('[agent-approve] claim error', claimErr);
    return new Response(JSON.stringify({ ok: false, error: claimErr.message }), { status: 500 });
  }
  if (!claimed) {
    return new Response(JSON.stringify({ ok: false, reason: 'not_claimable' }), { status: 200 });
  }

  const payload = claimed.payload as Record<string, unknown>;
  const provider = payload.provider;
  if (provider !== 'google' && provider !== 'microsoft') {
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(JSON.stringify({ ok: false, reason: 'bad_provider' }), { status: 500 });
  }

  // For mail.send_reply with an edited body, splice it into the payload so
  // the dispatcher uses the user's edit when sending the draft. (Drafts-
  // only Phase 3 path; the dispatcher reads draft_id directly.)
  const finalPayload = body.edited_body && claimed.action_type === 'mail.send_reply'
    ? { ...payload, edited_body: body.edited_body }
    : payload;

  let gmailTok = '';
  let outlookTok = '';
  try {
    if (provider === 'google') gmailTok = await loadGmailToken(client, userId);
    if (provider === 'microsoft') outlookTok = await loadOutlookToken(client, userId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-approve] token load', msg);
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 502 });
  }

  const ctx: ExecuteContext = {
    fetch: fetch as never,
    gmail: {
      accessToken: gmailTok,
      resolveLabelId: async (name: string) =>
        resolveLabelId({ fetch: fetch as never, accessToken: gmailTok, name }),
    },
    outlook: provider === 'microsoft' ? { accessToken: outlookTok } : undefined,
  };

  let exec;
  try {
    exec = await executeTool(
      claimed.action_type as ActionType,
      finalPayload,
      ctx,
      {
        policy: 'auto', // user tapped Send — treat as authorized auto
        // The user's explicit tap IS the safety check; bypass the runner's
        // unattended-send rails (which exist to gate auto-send during a tick).
        safety: {
          userIsIdle: true,
          hasRecipientHistory: async () => true,
          hasPriorFailedIdem: async () => false,
        },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-approve] execute', msg);
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 502 });
  }

  // Mirror to agent_actions so the executed row appears in the Today feed.
  try {
    await client.from('agent_actions').insert({
      user_id: userId,
      run_id: claimed.run_id,
      proposal_id: actionId,
      action_type: claimed.action_type,
      payload: exec.recordPayload,
      reversible: exec.reversible,
      reverse_token: exec.reverseToken,
    });
    await client
      .from('proposed_actions')
      .update({ status: 'executed', executed_at: new Date().toISOString() })
      .eq('id', actionId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-approve] post-execute write failed', msg);
    // The action already happened — we can't roll it back. Mark the
    // proposal failed so the row doesn't sit forever in 'approved'.
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(
      JSON.stringify({ ok: false, error: 'post_execute_write_failed', detail: msg }),
      { status: 500 },
    );
  }

  return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 });
});
