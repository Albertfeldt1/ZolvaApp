// supabase/functions/onboarding-backfill-status/index.ts
//
// Returns the caller's backfill_jobs rows. JWT-gated. Read-only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return json({ error: 'internal' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);

  // Use the JWT-bound client so RLS scopes the read to the caller.
  // The "users read own backfill jobs" policy on backfill_jobs handles auth.
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client
    .from('backfill_jobs')
    .select('id,kind,provider,status,processed,total,started_at,finished_at,error,updated_at')
    .order('created_at', { ascending: true });
  if (error) return json({ error: 'internal', detail: error.message }, 500);

  return json({ jobs: data ?? [] });
});
