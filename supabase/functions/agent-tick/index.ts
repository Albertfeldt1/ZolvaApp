// agent-tick - Phase 2 runner entry point.
//
// Invoked either by cron (with x-cron-secret) for every user with
// pending events, or by an authenticated user for their own row.
// Phase 2 wires real deps: Gmail, Claude, budget, idempotent actions.
// Smoke test: see docs/superpowers/plans/2026-05-12-autonomous-agent-phase-2-mail-triage.md task 13.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runAgent } from '../_shared/agent/runner.ts';
import type { AgentRunTrigger } from '../_shared/agent/types.ts';
import { buildDeps, selectEligibleUserIds } from '../_shared/agent/build-deps.ts';

const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
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
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  const isCron = CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET;
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE);

  let userIds: string[];
  let trigger: AgentRunTrigger = 'tick';

  if (isCron) {
    userIds = await selectEligibleUserIds(serviceClient);
  } else {
    const uid = await authenticatedUserId(req);
    if (!uid) return new Response('unauthorized', { status: 401 });
    userIds = [uid];
  }

  const results = [];
  for (const uid of userIds) {
    try {
      const deps = buildDeps(serviceClient, uid);
      const r = await runAgent({ userId: uid, trigger, deps });
      results.push({ userId: uid, ...r });
    } catch (err) {
      const msg = err instanceof Error
        ? `${err.name}: ${err.message}`
        : (() => {
            try { return JSON.stringify(err); } catch { return String(err); }
          })();
      console.error('[agent-tick] error for', uid, msg, err);
      results.push({ userId: uid, error: msg });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { 'content-type': 'application/json' },
  });
});
