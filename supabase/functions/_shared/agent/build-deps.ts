// _shared/agent/build-deps.ts
//
// Serve-free shared dependency builders used by BOTH agent-tick and
// agent-reflect. This module must NEVER call serve() or register an HTTP
// handler — importing it must have no request-handling side effects.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { ClaimedEvent, RunnerDeps } from './runner.ts';
import type { ActionType } from './types.ts';
import { loadTodayBudget, incrementBudget, DEFAULT_LIMITS } from './budget.ts';
import { callClaude } from './claude.ts';
import { recordAiUsage } from '../usage.ts';
import { executeTool as dispatchTool } from './tools/dispatch.ts';
import { resolveLabelId } from './tools/gmail.ts';
import type { ThreadBrief } from './prompt.ts';
import { loadRefreshToken, refreshAccessToken } from '../oauth.ts';
import { dispatchExpoPush } from './expo-push.ts';
import type { ExecuteContext, ExecuteOptions } from './tools/dispatch.ts';
import { hasRecipientHistory } from './allowlist.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

export async function loadGmailAccessToken(client: SupabaseClient, userId: string): Promise<string> {
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
      provider: ev.payload.provider === 'microsoft' ? 'microsoft' : 'google',
    });
  }
  return briefs;
}

export async function loadOutlookAccessToken(
  client: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const refresh = await loadRefreshToken(client, userId, 'microsoft');
  if (!refresh) return null;
  const { accessToken } = await refreshAccessToken(client, userId, 'microsoft', refresh);
  return accessToken;
}

async function loadPushTokens(
  client: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  if (error) {
    console.warn('[agent-tick] push_tokens read failed:', error.message);
    return [];
  }
  return (data ?? []).map((r: { token: string }) => r.token);
}

export function buildDeps(client: SupabaseClient, userId: string): RunnerDeps {
  // accessToken is loaded lazily once per run when first needed.
  let cachedAccessToken: string | null = null;
  let cachedOutlookToken: string | null | undefined = undefined;
  const accessToken = async (): Promise<string> => {
    if (!cachedAccessToken) cachedAccessToken = await loadGmailAccessToken(client, userId);
    return cachedAccessToken;
  };
  const outlookToken = async (): Promise<string | null> => {
    if (cachedOutlookToken === undefined) {
      cachedOutlookToken = await loadOutlookAccessToken(client, userId);
    }
    return cachedOutlookToken;
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
    async finishRun(runId, status, usage, errorMsg, trace) {
      const update: Record<string, unknown> = {
        status,
        finished_at: new Date().toISOString(),
      };
      if (usage) {
        update.input_tokens = usage.input_tokens;
        update.output_tokens = usage.output_tokens;
      }
      if (errorMsg) update.error = errorMsg.slice(0, 1000);
      if (trace && trace.length > 0) update.trace = trace;
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
      const out = await callClaude({
        fetch: fetch as never,
        apiKey: ANTHROPIC_API_KEY,
        system,
        messages,
        tools: tools as unknown[],
      });
      void recordAiUsage(client, userId, 'agent-tick', 'claude-haiku-4-5-20251001', out.usage);
      return out;
    },
    async executeTool(action: ActionType, payload, opts?: ExecuteOptions) {
      const gmailTok = await accessToken();
      const outlookTok = await outlookToken();
      const ctx: ExecuteContext = {
        fetch: fetch as never,
        gmail: {
          accessToken: gmailTok,
          resolveLabelId: (name) =>
            resolveLabelId({ fetch: fetch as never, accessToken: gmailTok, name }),
        },
        outlook: outlookTok ? { accessToken: outlookTok } : undefined,
      };
      return dispatchTool(action, payload, ctx, opts);
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
    async loadUserPolicy(uid) {
      const { data, error } = await client
        .from('user_agent_policy')
        .select('user_id, action_type, mode')
        .eq('user_id', uid);
      if (error) throw error;
      return (data ?? []) as Array<{ user_id: string; action_type: ActionType; mode: 'auto' | 'propose' | 'off' }>;
    },
    async loadActivePromotions(uid) {
      const { data, error } = await client
        .from('trust_offers')
        .select('action_type, recipient')
        .eq('user_id', uid)
        .eq('status', 'accepted');
      if (error) {
        console.warn('[agent-tick] trust promotions read failed:', error.message);
        return [];
      }
      return (data ?? []) as Array<{ action_type: string; recipient: string }>;
    },
    async loadUserPresence(uid) {
      const { data, error } = await client
        .from('user_presence')
        .select('last_active_at')
        .eq('user_id', uid)
        .maybeSingle();
      if (error) {
        console.warn('[agent-tick] presence read failed:', error.message);
        return null;
      }
      if (!data?.last_active_at) return null;
      return new Date(data.last_active_at as string);
    },
    async writeProposedAction(row) {
      const { data, error } = await client
        .from('proposed_actions')
        .insert({
          user_id: row.user_id,
          run_id: row.run_id,
          action_type: row.action_type,
          payload: row.payload,
          preview: row.preview,
          status: 'pending',
          expires_at: row.expires_at,
        })
        .select('id').single();
      if (error) throw error;
      return data!.id as string;
    },
    async dispatchProposalPush(uid, preview) {
      const tokens = await loadPushTokens(client, uid);
      await dispatchExpoPush({
        fetch: fetch as never,
        tokens,
        title: preview.title,
        body: preview.body,
        data: { type: 'agent_proposal', action_id: preview.actionId },
      });
    },
    async fireNudge(args) {
      // Insert the agent_actions row FIRST — the agent_actions_idem uniq index
      // (user_id, action_type, idem_key) is the rate-limit gate. A 23505 means
      // this topic was already nudged today, so we send nothing.
      const { error } = await client.from('agent_actions').insert({
        user_id: args.user_id,
        run_id: args.run_id,
        action_type: 'nudge.push',
        payload: args.payload,
        reversible: false,
        reverse_token: null,
      });
      if (error) {
        if ((error as { code?: string }).code === '23505') return { sent: false };
        throw error;
      }
      // The row is the receipt of a SENT push, and its idem key is day-scoped —
      // so if the push send fails after the row committed, that key would
      // suppress every retry for the rest of the day and the user would never
      // be notified. Roll the row back on send failure so the next tick retries.
      const tokens = await loadPushTokens(client, args.user_id);
      try {
        await dispatchExpoPush({
          fetch: fetch as never,
          tokens,
          title: args.title,
          body: args.body,
          data: args.data,
        });
      } catch (sendErr) {
        await client
          .from('agent_actions')
          .delete()
          .eq('user_id', args.user_id)
          .eq('action_type', 'nudge.push')
          .eq('payload->>idem_key', String(args.payload.idem_key ?? ''));
        throw sendErr;
      }
      return { sent: true };
    },
    async isUserIdle(uid, now) {
      const { data, error } = await client
        .from('user_presence')
        .select('last_active_at')
        .eq('user_id', uid)
        .maybeSingle();
      if (error) {
        console.warn('[agent-tick] presence read failed:', error.message);
        // Treat unknown presence as idle — fail-open is fine because the
        // recipient allowlist + idem check are the harder rails to clear.
        return true;
      }
      if (!data?.last_active_at) return true;
      const ageMs = now.getTime() - new Date(data.last_active_at as string).getTime();
      return ageMs >= 60_000;
    },
    async recipientAllowlistCheck(uid, addr) {
      return hasRecipientHistory(client, {
        userId: uid,
        address: addr,
        threshold: 3,
        withinDays: 60,
      });
    },
    async priorFailedSendIdem(uid, idemKey) {
      // agent_actions has no status column — failures don't land there.
      // The actual failure signal lives on proposed_actions.status='failed'
      // (set by agent-approve when a send hits a provider 4xx/5xx).
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data, error } = await client
        .from('proposed_actions')
        .select('id')
        .eq('user_id', uid)
        .eq('status', 'failed')
        .eq('payload->>idem_key', idemKey)
        .gte('created_at', cutoff)
        .limit(1);
      if (error) {
        console.warn('[agent-tick] prior-failed-idem check failed:', error.message);
        // Fail-safe: assume there WAS a prior failure so we don't auto-send.
        return true;
      }
      return (data?.length ?? 0) > 0;
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
