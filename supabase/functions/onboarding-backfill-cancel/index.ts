// supabase/functions/onboarding-backfill-cancel/index.ts
//
// Marks any queued or running backfill_jobs for the caller as 'cancelled'.
// JWT-gated. The orchestrator's worker loop checks isCancelled() before
// each batch slice and bails when set.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) return json({ error: 'internal' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await service
    .from('backfill_jobs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .select('id');
  if (error) return json({ error: 'internal', detail: error.message }, 500);
  return json({ cancelled: data?.length ?? 0 });
});
