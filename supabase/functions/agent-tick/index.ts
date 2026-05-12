// agent-tick - Phase 1 plumbing entry point.
//
// Invoked either by cron (with x-cron-secret) for every user with
// pending events, or by an authenticated user for their own row.
// Phase 1 is a no-op: runAgent() drains the queue without doing any
// Claude work. Phase 2 wires real tool execution into runner.ts.
// Smoke test: see docs/superpowers/plans/2026-05-11-autonomous-agent-phase-1-plumbing.md task 7.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runAgent } from '../_shared/agent/runner.ts';
import type { ClaimedEvent, RunnerDeps } from '../_shared/agent/runner.ts';
import type { AgentRunTrigger } from '../_shared/agent/types.ts';

const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function buildDeps(client: SupabaseClient, userId: string): RunnerDeps {
  return {
    async claimEvents(uid, limit) {
      const { data, error } = await client.rpc('agent_claim_events', {
        p_user_id: uid,
        p_limit: limit,
      });
      if (error) throw error;
      return (data ?? []) as ClaimedEvent[];
    },
    async openRun(uid, trigger, eventIds) {
      const { data, error } = await client
        .from('agent_runs')
        .insert({
          user_id: uid,
          trigger,
          event_ids: eventIds,
          status: 'running',
        })
        .select('id')
        .single();
      if (error) throw error;
      return data!.id as string;
    },
    async finishRun(runId, status) {
      const { error } = await client
        .from('agent_runs')
        .update({ status, finished_at: new Date().toISOString() })
        .eq('id', runId);
      if (error) throw error;
    },
    async markProcessed(eventIds) {
      if (eventIds.length === 0) return;
      const { error } = await client
        .from('agent_events')
        .update({ processed_at: new Date().toISOString() })
        .in('id', eventIds);
      if (error) throw error;
    },
  };
}

export async function selectEligibleUserIds(
  client: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await client
    .from('v_users_with_pending_agent_events')
    .select('user_id');
  if (error) throw error;
  return Array.from(
    new Set((data ?? []).map((r: { user_id: string }) => r.user_id)),
  );
}

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
      console.error('[agent-tick] error for', uid, err);
      results.push({ userId: uid, error: String(err) });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { 'content-type': 'application/json' },
  });
});
