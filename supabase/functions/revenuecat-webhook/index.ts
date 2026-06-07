// supabase/functions/revenuecat-webhook/index.ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleWebhook } from './handler.ts';
import type { EntitlementState } from '../_shared/entitlement.ts';

function admin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, { auth: { persistSession: false } });
}

serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization');
  let payload: unknown = null;
  try { payload = await req.json(); } catch { payload = null; }

  const client = admin();
  const result = await handleWebhook(authHeader, payload as { event?: never } | null, {
    secret: Deno.env.get('REVENUECAT_WEBHOOK_SECRET') ?? '',
    upsert: async (userId, state: EntitlementState, raw) => {
      await client.from('user_entitlements').upsert({
        user_id: userId,
        tier: state.tier,
        is_trial: state.is_trial,
        current_period_end: state.current_period_end,
        store: state.store,
        product_id: state.product_id,
        rc_app_user_id: userId,
        updated_at: new Date().toISOString(),
        raw_event: raw,
      }, { onConflict: 'user_id' });
    },
    expire: async (userId, raw) => {
      await client.from('user_entitlements').upsert({
        user_id: userId,
        tier: 'free',
        is_trial: false,
        current_period_end: null,
        rc_app_user_id: userId,
        updated_at: new Date().toISOString(),
        raw_event: raw,
      }, { onConflict: 'user_id' });
    },
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
});
