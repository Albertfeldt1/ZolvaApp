// agent-approve - execute a pending proposed_action on user approval.
//
// JWT-authenticated only. Reads the proposed_actions row by id, verifies
// ownership + status='pending' + not expired, dispatches the action via
// the same tool catalog the runner uses, transitions the proposal row.
//
// Phase 3 only handles mail.send_reply (the sole propose action shipped).

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import { gmailSendDraft } from '../_shared/agent/tools/gmail.ts';
import { outlookSendDraft } from '../_shared/agent/tools/outlook.ts';

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
  const draftId = payload.draft_id as string | undefined;
  if (!draftId || (provider !== 'google' && provider !== 'microsoft')) {
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(JSON.stringify({ ok: false, reason: 'bad_payload' }), { status: 500 });
  }

  try {
    if (provider === 'google') {
      const tok = await loadGmailToken(client, userId);
      await gmailSendDraft({ fetch: fetch as never, accessToken: tok, draftId });
    } else {
      const tok = await loadOutlookToken(client, userId);
      await outlookSendDraft({ fetch: fetch as never, accessToken: tok, draftId });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-approve] send error', msg);
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 502 });
  }

  // Mirror to agent_actions so the executed row appears in the Today feed.
  await client.from('agent_actions').insert({
    user_id: userId,
    run_id: claimed.run_id,
    proposal_id: actionId,
    action_type: claimed.action_type,
    payload,
    reversible: false,
    reverse_token: null,
  });
  await client
    .from('proposed_actions')
    .update({ status: 'executed', executed_at: new Date().toISOString() })
    .eq('id', actionId);

  return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 });
});
