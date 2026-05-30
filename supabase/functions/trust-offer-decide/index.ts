// supabase/functions/trust-offer-decide/index.ts
//
// JWT-authed endpoint called by the iOS widget AppIntents
// (AcceptTrustOfferIntent / DismissTrustOfferIntent) to transition a
// trust_offers row from 'pending' to 'accepted' or 'dismissed'. Mirrors
// the agent-approve / widget-action pattern.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const userId = await authenticatedUserId(req);
  if (!userId) return new Response('unauthorized', { status: 401 });

  let body: { offer_id?: string; decision?: 'accepted' | 'dismissed' };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const offerId = body.offer_id;
  const decision = body.decision;
  if (!offerId || (decision !== 'accepted' && decision !== 'dismissed')) {
    return new Response('offer_id + decision required', { status: 400 });
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Atomic transition: pending → accepted|dismissed, only if owned by caller.
  const { data: claimed, error } = await client
    .from('trust_offers')
    .update({ status: decision, decided_at: new Date().toISOString() })
    .eq('id', offerId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id, status')
    .maybeSingle();
  if (error) {
    console.error('[trust-offer-decide] update error', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }
  if (!claimed) {
    // Already decided or not owned — idempotent success from widget's POV.
    return new Response(JSON.stringify({ ok: true, alreadyDecided: true }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});
