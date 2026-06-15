// supabase/functions/revenuecat-webhook/index.ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleWebhook } from './handler.ts';
import type { EntitlementState } from '../_shared/entitlement.ts';

// Fail closed: a missing secret must crash the isolate at startup rather than
// silently accept requests (an empty secret would otherwise match an empty
// Authorization header).
const WEBHOOK_SECRET = Deno.env.get('REVENUECAT_WEBHOOK_SECRET');
if (!WEBHOOK_SECRET) {
  throw new Error('REVENUECAT_WEBHOOK_SECRET is not set');
}

function admin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, { auth: { persistSession: false } });
}

const json = (status: number, body: { ok: boolean; reason?: string }): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization');
  let payload: unknown = null;
  try { payload = await req.json(); } catch { payload = null; }

  const client = admin();
  try {
    // Event time we record on each write, used by the ordering guard. Falls
    // back to server time when RevenueCat omits a timestamp.
    const eventAtIso = (eventAtMs: number | null): string =>
      eventAtMs != null ? new Date(eventAtMs).toISOString() : new Date().toISOString();

    const result = await handleWebhook(authHeader, payload as { event?: never } | null, {
      secret: WEBHOOK_SECRET,
      readEventTimestamp: async (userId) => {
        const { data, error } = await client
          .from('user_entitlements')
          .select('last_event_at')
          .eq('user_id', userId)
          .maybeSingle();
        // Fail open: a read error degrades to last-write-wins rather than
        // dropping the event or 500-ing the webhook.
        if (error) return null;
        return (data?.last_event_at as string | null) ?? null;
      },
      upsert: async (userId, state: EntitlementState, eventAtMs, raw) => {
        const { error } = await client.from('user_entitlements').upsert({
          user_id: userId,
          tier: state.tier,
          is_trial: state.is_trial,
          current_period_end: state.current_period_end,
          store: state.store,
          product_id: state.product_id,
          rc_app_user_id: userId,
          updated_at: new Date().toISOString(),
          last_event_at: eventAtIso(eventAtMs),
          raw_event: raw,
        }, { onConflict: 'user_id' });
        if (error) throw error;
      },
      expire: async (userId, eventAtMs, raw) => {
        const { error } = await client.from('user_entitlements').upsert({
          user_id: userId,
          tier: 'free',
          is_trial: false,
          current_period_end: null,
          store: null,
          product_id: null,
          rc_app_user_id: userId,
          updated_at: new Date().toISOString(),
          last_event_at: eventAtIso(eventAtMs),
          raw_event: raw,
        }, { onConflict: 'user_id' });
        if (error) throw error;
      },
      onNonPro: async (userId) => {
        // Open loops ("Open loops") are a Pro-only surface: once a user is
        // non-pro, agent-commitments stops reconciling them, so any still-open
        // row would linger forever as a zombie. Expire them here at the
        // downgrade moment. Idempotent — re-running only re-expires open rows.
        const { error } = await client
          .from('agent_commitments')
          .update({ status: 'expired' })
          .eq('user_id', userId)
          .in('status', ['open', 'nudged']);
        if (error) throw error;
      },
    });
    return json(result.status, result.body);
  } catch (_e) {
    // Surface write failures as 5xx so RevenueCat retries instead of
    // treating a dropped write as success.
    return json(500, { ok: false, reason: 'internal error' });
  }
});
