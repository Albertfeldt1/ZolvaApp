// agent-tick - Phase 2 runner entry point.
//
// Invoked either by cron (with x-cron-secret) for every user with
// pending events, or by an authenticated user for their own row.
// Phase 2 wires real deps: Gmail, Claude, budget, idempotent actions.
// Smoke test: see docs/superpowers/plans/2026-05-11-autonomous-agent-phase-1-plumbing.md task 7.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runAgent } from '../_shared/agent/runner.ts';
import type { ClaimedEvent, RunnerDeps } from '../_shared/agent/runner.ts';
import type { AgentRunTrigger, ActionType } from '../_shared/agent/types.ts';
import { loadTodayBudget, incrementBudget, DEFAULT_LIMITS } from '../_shared/agent/budget.ts';
import { callClaude } from '../_shared/agent/claude.ts';
import { executeTool as dispatchTool } from '../_shared/agent/tools/dispatch.ts';
import { resolveLabelId } from '../_shared/agent/tools/gmail.ts';
import type { ThreadBrief } from '../_shared/agent/prompt.ts';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';

const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

async function loadGmailAccessToken(client: SupabaseClient, userId: string): Promise<string> {
  const refreshToken = await loadRefreshToken(client, userId, 'google');
  if (!refreshToken) throw new Error('no google refresh token for user');
  const { accessToken } = await refreshAccessToken(client, userId, 'google', refreshToken);
  return accessToken;
}

async function loadThreadBriefs(
  accessToken: string,
  events: ClaimedEvent[],
): Promise<ThreadBrief[]> {
  const seen = new Set<string>();
  const briefs: ThreadBrief[] = [];
  for (const ev of events) {
    if (ev.kind !== 'mail.new') continue;
    const threadId = typeof ev.payload.thread_id === 'string' ? ev.payload.thread_id : '';
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) continue;
    const j = (await res.json()) as {
      messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> }; snippet?: string }>;
    };
    const msg = j.messages?.[0];
    const headers = msg?.payload?.headers ?? [];
    briefs.push({
      thread_id: threadId,
      from: headers.find((h) => h.name === 'From')?.value ?? '',
      subject: headers.find((h) => h.name === 'Subject')?.value ?? '(uden emne)',
      snippet: msg?.snippet ?? '',
    });
  }
  return briefs;
}

function buildDeps(client: SupabaseClient, userId: string): RunnerDeps {
  // accessToken is loaded lazily once per run when first needed.
  let cachedAccessToken: string | null = null;
  const accessToken = async (): Promise<string> => {
    if (!cachedAccessToken) cachedAccessToken = await loadGmailAccessToken(client, userId);
    return cachedAccessToken;
  };

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
        .insert({ user_id: uid, trigger, event_ids: eventIds, status: 'running' })
        .select('id').single();
      if (error) throw error;
      return data!.id as string;
    },
    async finishRun(runId, status, usage, errorMsg) {
      const update: Record<string, unknown> = {
        status,
        finished_at: new Date().toISOString(),
      };
      if (usage) {
        update.input_tokens = usage.input_tokens;
        update.output_tokens = usage.output_tokens;
      }
      if (errorMsg) update.error = errorMsg.slice(0, 1000);
      const { error } = await client.from('agent_runs').update(update).eq('id', runId);
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
    async checkBudget(uid) {
      const snap = await loadTodayBudget(client, uid);
      return {
        exceeded:
          snap.inputTokens >= DEFAULT_LIMITS.dailyInput ||
          snap.outputTokens >= DEFAULT_LIMITS.dailyOutput,
      };
    },
    async loadThreadBriefs(_uid, events) {
      if (events.length === 0) return [];
      return loadThreadBriefs(await accessToken(), events);
    },
    async callClaudeTurn(system, messages, tools) {
      return callClaude({
        fetch: fetch as never,
        apiKey: ANTHROPIC_API_KEY,
        system,
        messages,
        tools: tools as unknown[],
      });
    },
    async executeTool(action: ActionType, payload) {
      const tok = await accessToken();
      return dispatchTool(action, payload, {
        accessToken: tok,
        fetch: fetch as never,
        resolveLabelId: (name) => resolveLabelId({ fetch: fetch as never, accessToken: tok, name }),
      });
    },
    async recordAction(row) {
      const { error } = await client.from('agent_actions').insert({
        user_id: row.user_id,
        run_id: row.run_id,
        action_type: row.action_type,
        payload: row.payload,
        reversible: row.reversible,
        reverse_token: row.reverse_token,
      });
      if (error) {
        // Duplicate idem_key (23505) is a benign collision: another runner
        // already executed this action. Don't crash the loop.
        if ((error as { code?: string }).code === '23505') return;
        throw error;
      }
    },
    async incrementBudget(uid, usage) {
      await incrementBudget(client, uid, {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      });
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
