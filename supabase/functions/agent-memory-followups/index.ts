// supabase/functions/agent-memory-followups/index.ts
//
// Memory-followups sweep (~hourly daytime). Per agent_enabled user, quiet-hours
// gated: read confirmed facts whose follow_up_at has passed and that have not
// been acted on, emit one deduped fact.due event per fact, run the followup
// strategy, then stamp followed_up_at so each fires once. Mirrors agent-reflect.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runMemoryFollowup } from '../_shared/agent/runner.ts';
import type { ClaimedEvent } from '../_shared/agent/runner.ts';
import { buildDeps, selectDueFollowupFacts, markFactsFollowedUp } from '../_shared/agent/build-deps.ts';
import { selectDueFollowups, toFactDuePayload } from '../_shared/agent/followup-facts.ts';
import { isQuietHours } from '../_shared/agent/quiet-hours.ts';

const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
if (!CRON_SECRET) {
  throw new Error('[agent-memory-followups] CRON_SHARED_SECRET is not set — refusing to start');
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function copenhagenDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

async function selectAgentEnabledUsers(
  client: SupabaseClient,
): Promise<Array<{ userId: string; timezone: string }>> {
  const { data, error } = await client
    .from('user_profiles')
    .select('user_id, timezone')
    .eq('agent_enabled', true);
  if (error) throw error;
  const seen = new Set<string>();
  const out: Array<{ userId: string; timezone: string }> = [];
  for (const r of (data ?? []) as Array<{ user_id: string; timezone: string | null }>) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    out.push({ userId: r.user_id, timezone: r.timezone || 'Europe/Copenhagen' });
  }
  return out;
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = new Date();
  const nowIso = now.toISOString();
  const day = copenhagenDay(now);
  const users = await selectAgentEnabledUsers(client);

  const results: Array<{ userId: string; ran: boolean; reason?: string; error?: string }> = [];
  for (const { userId: uid, timezone } of users) {
    try {
      if (isQuietHours(now, timezone)) {
        results.push({ userId: uid, ran: false, reason: 'quiet_hours' });
        continue;
      }

      const dueRows = selectDueFollowups(await selectDueFollowupFacts(client, uid, nowIso), now);
      if (dueRows.length === 0) {
        results.push({ userId: uid, ran: false });
        continue;
      }

      // Emit one deduped fact.due event per fact (mirrors reflect's per-row insert;
      // the agent_events_fact_due_dedup unique index raises 23505 once per day).
      const fresh: ClaimedEvent[] = [];
      const factIds: string[] = [];
      for (const f of dueRows) {
        const payload = toFactDuePayload(f, day);
        const { data, error } = await client
          .from('agent_events')
          .insert({ user_id: uid, kind: 'fact.due', payload })
          .select('id, kind, payload')
          .single();
        if (error) {
          if ((error as { code?: string }).code === '23505') continue; // already emitted today
          throw error;
        }
        fresh.push(data as ClaimedEvent);
        factIds.push(f.id);
      }

      if (fresh.length === 0) {
        results.push({ userId: uid, ran: false });
        continue;
      }

      const deps = buildDeps(client, uid);
      const result = await runMemoryFollowup({ userId: uid, events: fresh, deps });
      // Stamp followed_up_at ONLY after a clean run, so each fact fires once.
      // A budget-gated or errored cycle leaves followed_up_at null: the same-day
      // re-emit is blocked by agent_events_fact_due_dedup, so the fact retries on
      // the next day's sweep rather than being permanently silenced.
      if (result.status === 'ok') {
        await markFactsFollowedUp(client, factIds, nowIso);
      }
      results.push({
        userId: uid,
        ran: result.status === 'ok',
        reason: result.status === 'ok' ? undefined : result.status,
      });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error('[agent-memory-followups] error for', uid, msg);
      results.push({ userId: uid, ran: false, error: msg });
    }
  }

  return new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json' } });
});
