// agent-dismiss - decline a pending proposed_action ("Spring over").
//
// JWT-authenticated only. Atomically claims the proposed_actions row
// (pending -> dismissed, owned by caller), then best-effort deletes the
// underlying mail draft so dismissing a "Send svar?" proposal doesn't leave
// an orphan draft in the user's mailbox. (cal.* proposals create nothing in
// propose mode, so there is nothing to clean up.)
//
// Dismissal is the primary intent and is committed first; draft cleanup is
// best-effort — a provider failure is logged and surfaced via draft_deleted
// but never un-dismisses the proposal.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import { gmailDeleteDraft } from '../_shared/agent/tools/gmail.ts';
import { outlookDeleteDraft } from '../_shared/agent/tools/outlook.ts';
import { draftDeletionForProposal } from '../_shared/agent/dismiss.ts';

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

async function providerAccessToken(
  client: SupabaseClient,
  userId: string,
  provider: 'google' | 'microsoft',
): Promise<string> {
  const r = await loadRefreshToken(client, userId, provider);
  if (!r) throw new Error(`no ${provider} refresh token`);
  // Mail-scoped draft delete — the default scope is mail, so no per-refresh
  // scope override (unlike calendar writes which need Calendars.ReadWrite).
  const { accessToken } = await refreshAccessToken(client, userId, provider, r);
  return accessToken;
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

  // Atomic claim: pending -> dismissed, only if owned by caller. The status
  // guard makes a double-tap a no-op rather than clobbering an approved row.
  const { data: claimed, error: claimErr } = await client
    .from('proposed_actions')
    .update({ status: 'dismissed', decided_at: new Date().toISOString() })
    .eq('id', actionId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('action_type, payload')
    .maybeSingle();
  if (claimErr) {
    console.error('[agent-dismiss] claim error', claimErr);
    return new Response(JSON.stringify({ ok: false, error: claimErr.message }), { status: 500 });
  }
  if (!claimed) {
    return new Response(JSON.stringify({ ok: false, reason: 'not_claimable' }), { status: 200 });
  }

  const deletion = draftDeletionForProposal(
    claimed.action_type as string,
    claimed.payload as Record<string, unknown>,
  );
  if (!deletion) {
    return new Response(JSON.stringify({ ok: true, dismissed: true }), { status: 200 });
  }

  // Best-effort cleanup. The proposal is already dismissed; if the provider
  // call fails the orphan simply remains (logged), same as the old behavior.
  try {
    const accessToken = await providerAccessToken(client, userId, deletion.provider);
    if (deletion.provider === 'google') {
      await gmailDeleteDraft({ fetch: fetch as never, accessToken, draftId: deletion.draftId });
    } else {
      await outlookDeleteDraft({ fetch: fetch as never, accessToken, draftId: deletion.draftId });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-dismiss] draft cleanup failed', msg);
    return new Response(JSON.stringify({ ok: true, dismissed: true, draft_deleted: false }), { status: 200 });
  }

  return new Response(JSON.stringify({ ok: true, dismissed: true, draft_deleted: true }), { status: 200 });
});
