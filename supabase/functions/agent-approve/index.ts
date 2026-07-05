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
import { shouldOfferPromotion } from '../_shared/agent/trust.ts';

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

async function loadOutlookToken(
  client: SupabaseClient,
  userId: string,
  actionType: string,
): Promise<string> {
  const r = await loadRefreshToken(client, userId, 'microsoft');
  if (!r) throw new Error('no microsoft refresh token');
  // Microsoft scopes tokens per-refresh. Calendar writes need Calendars.ReadWrite;
  // mail actions use the default mail scope. Requesting the wrong scope 403s.
  const microsoftScope = actionType.startsWith('cal.')
    ? 'offline_access Calendars.ReadWrite'
    : undefined;
  const { accessToken } = await refreshAccessToken(
    client,
    userId,
    'microsoft',
    r,
    microsoftScope ? { microsoftScope } : {},
  );
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
    if (provider === 'microsoft') outlookTok = await loadOutlookToken(client, userId, claimed.action_type);
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
          // The user tapped Send — the body-grounding rail (which gates
          // unattended auto-send) does not apply. Without this the dispatcher
          // calls undefined() at the threadWasResearched check and throws.
          threadWasResearched: () => true,
          // The guardrail gate exists for unattended auto-sends; the user's
          // explicit approval IS the authorization here. Omitting this made
          // the dispatcher degrade every approval to 'propose' (no send)
          // while this function still marked the proposal executed.
          railsOk: true,
        },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-approve] execute', msg);
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 502 });
  }

  // The dispatcher degrades to 'propose' when a safety gate refuses the send.
  // On this path nothing left the mailbox — treat it as a failure instead of
  // recording an executed action that never happened.
  if (exec.mode !== 'executed') {
    console.error('[agent-approve] dispatcher refused send (mode=propose)', claimed.action_type);
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(
      JSON.stringify({ ok: false, error: 'dispatch_refused' }),
      { status: 502 },
    );
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

  // Trust escalation: >=3 approvals for the same recipient + no live offer
  // -> surface a one-tap "auto from now on?" card in Today. Best-effort:
  // failures are logged but don't block the success response.
  try {
    const toAddr = typeof payload.to === 'string' ? payload.to : '';
    await maybeCreateTrustOffer(client, userId, claimed.action_type, toAddr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-approve] trust escalation check failed', msg);
  }

  return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 });
});

async function maybeCreateTrustOffer(
  client: SupabaseClient,
  userId: string,
  actionType: string,
  recipient: string,
): Promise<void> {
  if (actionType !== 'mail.send_reply') return;
  if (!recipient) return;

  // Email recipients are case-insensitive. resolveTrustPolicy lowercases on
  // match, and the uniq partial index is case-sensitive text — so we must
  // store + look up + count by a single canonical (lowercased) form, or a
  // case-variant send could double-prompt or miss the threshold.
  const normalized = recipient.toLowerCase();

  // Lifetime count of approved sends to this recipient. PostgREST exposes
  // JSONB extraction via the ->> operator inside filter values; ilike makes
  // the match case-insensitive against historically-stored payload casing.
  const { count, error: countErr } = await client
    .from('proposed_actions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .eq('status', 'executed')
    .ilike('payload->>to', normalized);
  if (countErr) {
    console.error('[agent-approve] trust count error', countErr);
    return;
  }

  // Most recent offer for this slot.
  const { data: latest, error: latestErr } = await client
    .from('trust_offers')
    .select('status')
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .eq('recipient', normalized)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    console.error('[agent-approve] trust latest error', latestErr);
    return;
  }

  if (!shouldOfferPromotion(count ?? 0, latest?.status ?? null)) return;

  const { error: insertErr } = await client.from('trust_offers').insert({
    user_id: userId,
    action_type: actionType,
    recipient: normalized,
    status: 'pending',
    approval_count: count,
  });
  // Uniq partial index can race with a concurrent approval — swallow 23505.
  if (insertErr && insertErr.code !== '23505') {
    console.error('[agent-approve] trust insert error', insertErr);
  }
}
