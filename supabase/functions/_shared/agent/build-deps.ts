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
import type { ThreadBrief, ScanCandidate } from './prompt.ts';
import { parseGmailThreadState, parseGraphThreadState } from './commitments.ts';
import type { CommitmentRow, GmailThreadMeta, GraphMessageLite, ThreadState } from './commitments.ts';
import type { FollowupFactRow } from './followup-facts.ts';
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

async function loadGmailBrief(accessToken: string, threadId: string): Promise<ThreadBrief | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as {
    messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> }; snippet?: string }>;
  };
  const msg = j.messages?.[0];
  const headers = msg?.payload?.headers ?? [];
  return {
    thread_id: threadId,
    from: headers.find((h) => h.name === 'From')?.value ?? '',
    subject: headers.find((h) => h.name === 'Subject')?.value ?? '(uden emne)',
    snippet: msg?.snippet ?? '',
    provider: 'google',
  };
}

// Outlook brief: the newest message in the conversation, via Graph. conversationId
// is Outlook's thread key (carried as thread_id in the mail.new event).
async function loadOutlookBrief(accessToken: string, conversationId: string): Promise<ThreadBrief | null> {
  const url =
    `https://graph.microsoft.com/v1.0/me/messages?$filter=conversationId eq '${conversationId}'` +
    `&$orderby=sentDateTime desc&$top=1&$select=subject,from,bodyPreview`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    value?: Array<{ subject?: string; bodyPreview?: string; from?: { emailAddress?: { name?: string; address?: string } } }>;
  };
  const msg = j.value?.[0];
  if (!msg) return null;
  const fromAddr = msg.from?.emailAddress;
  return {
    thread_id: conversationId,
    from: fromAddr ? `${fromAddr.name ?? ''} <${fromAddr.address ?? ''}>`.trim() : '',
    subject: msg.subject || '(uden emne)',
    snippet: msg.bodyPreview ?? '',
    provider: 'microsoft',
  };
}

// Build a brief per claimed mail.new thread, routed by provider. Each provider's
// token is resolved at most once and only if it has an event — so an Outlook-only
// user (no Google grant) never triggers the Gmail token load, which throws. A
// token failure disables that provider's briefs rather than the whole run.
async function loadThreadBriefs(
  events: ClaimedEvent[],
  getGoogleToken: () => Promise<string>,
  getOutlookToken: () => Promise<string | null>,
): Promise<ThreadBrief[]> {
  let googleTok: string | null | undefined;
  let outlookTok: string | null | undefined;
  const google = async (): Promise<string | null> => {
    if (googleTok === undefined) { try { googleTok = await getGoogleToken(); } catch { googleTok = null; } }
    return googleTok;
  };
  const outlook = async (): Promise<string | null> => {
    if (outlookTok === undefined) { try { outlookTok = await getOutlookToken(); } catch { outlookTok = null; } }
    return outlookTok;
  };

  const seen = new Set<string>();
  const briefs: ThreadBrief[] = [];
  for (const ev of events) {
    if (ev.kind !== 'mail.new') continue;
    const threadId = typeof ev.payload.thread_id === 'string' ? ev.payload.thread_id : '';
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    if (ev.payload.provider === 'microsoft') {
      const tok = await outlook();
      const brief = tok ? await loadOutlookBrief(tok, threadId) : null;
      if (brief) briefs.push(brief);
    } else {
      const tok = await google();
      const brief = tok ? await loadGmailBrief(tok, threadId) : null;
      if (brief) briefs.push(brief);
    }
  }
  return briefs;
}

export async function loadOutlookAccessToken(
  client: SupabaseClient,
  userId: string,
  microsoftScope?: string,
): Promise<string | null> {
  const refresh = await loadRefreshToken(client, userId, 'microsoft');
  if (!refresh) return null;
  // Microsoft scopes tokens per-refresh: the default grant is mail-only, so a
  // calendar write needs Calendars.ReadWrite requested explicitly or Graph 403s.
  const { accessToken } = await refreshAccessToken(
    client, userId, 'microsoft', refresh,
    microsoftScope ? { microsoftScope } : {},
  );
  return accessToken;
}

// Mailbox owner address (for outbound/inbound direction in commitment reconcile).
export async function loadOutlookUserAddress(token: string): Promise<string | null> {
  const res = await fetch(
    'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as { mail?: string | null; userPrincipalName?: string | null };
  return j.mail || j.userPrincipalName || null;
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
  let cachedOutlookMailToken: string | null | undefined = undefined;
  let cachedOutlookCalToken: string | null | undefined = undefined;
  const accessToken = async (): Promise<string> => {
    if (!cachedAccessToken) cachedAccessToken = await loadGmailAccessToken(client, userId);
    return cachedAccessToken;
  };
  // Default Outlook token is mail-scoped; calendar writes need a separately
  // refreshed Calendars.ReadWrite token (Microsoft scopes per-refresh).
  const outlookToken = async (): Promise<string | null> => {
    if (cachedOutlookMailToken === undefined) {
      cachedOutlookMailToken = await loadOutlookAccessToken(client, userId);
    }
    return cachedOutlookMailToken;
  };
  const outlookCalToken = async (): Promise<string | null> => {
    if (cachedOutlookCalToken === undefined) {
      cachedOutlookCalToken = await loadOutlookAccessToken(client, userId, 'offline_access Calendars.ReadWrite');
    }
    return cachedOutlookCalToken;
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
      return loadThreadBriefs(events, accessToken, outlookToken);
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
      // Resolve the Gmail token defensively: an Outlook-only user has no Google
      // grant, and loadGmailAccessToken throws. A google-branch tool would then
      // 401 (surfaced as is_error per tool) instead of crashing the whole run;
      // microsoft + provider-less actions don't touch ctx.gmail at all.
      let gmailTok = '';
      try { gmailTok = await accessToken(); } catch { /* no google grant; google tools will 401 */ }
      // Calendar actions need the Calendars.ReadWrite-scoped Outlook token; mail
      // actions use the default mail-scoped one. Requesting the wrong scope 403s.
      const outlookTok = action.startsWith('cal.') ? await outlookCalToken() : await outlookToken();
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
    async recordCommitment(uid, _runId, c) {
      // Upsert on the (user_id, thread_id, direction) unique key. onConflict
      // refreshes the mutable fields so a re-scan updates rather than dupes,
      // but never touches `status` — a resolved/dismissed loop stays closed.
      const { error } = await client
        .from('agent_commitments')
        .upsert({
          user_id: uid,
          direction: c.direction,
          counterparty: c.counterparty ?? '',
          summary: c.summary,
          due_at: c.due_at ?? null,
          due_inferred: c.due_inferred ?? false,
          thread_id: c.thread_id,
          provider: c.provider,
          source_excerpt: c.source_excerpt ?? '',
          last_message_at: c.last_message_at ?? null,
        }, { onConflict: 'user_id,thread_id,direction', ignoreDuplicates: false });
      if (error) throw error;
      return 'inserted';
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

// Fetch recent SENT threads as scan candidates. Gmail: in:sent newer_than:7d.
// One representative message per thread (the user's own latest text in it).
// Per-provider failures are swallowed (logged) so one bad provider can't blank
// the scan — mirrors agent-reflect's readUpcoming. Outlook sent-items is a
// Slice 2 follow-up; Gmail-only candidates here.
export async function listSentCandidates(
  client: SupabaseClient,
  userId: string,
): Promise<ScanCandidate[]> {
  const out: ScanCandidate[] = [];
  try {
    const token = await loadGmailAccessToken(client, userId);
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${encodeURIComponent('in:sent newer_than:7d')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (listRes.ok) {
      const list = await listRes.json() as { messages?: Array<{ id: string; threadId: string }> };
      const seen = new Set<string>();
      for (const m of list.messages ?? []) {
        if (seen.has(m.threadId)) continue;
        seen.add(m.threadId);
        const getRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!getRes.ok) continue;
        const msg = await getRes.json() as { threadId: string; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } };
        const h = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? '';
        const dateHeader = h('date');
        out.push({
          thread_id: msg.threadId,
          provider: 'google',
          counterparty: h('to'),
          subject: h('subject'),
          latest_text: msg.snippet ?? '',
          latest_from: 'user',
          latest_at: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
          kind: 'sent_recent',
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('no google refresh token')) console.warn('[agent-commitments] sent scan (google) failed for', userId, msg);
  }
  return out;
}

// Stale "waiting on a reply" candidates (Slice 2 → owed_to_you). Find sent
// messages 3–30 days old, then keep only threads whose LATEST message is still
// the user's own (label SENT) — i.e. nobody replied, so the ball is in the other
// party's court. The scan's Claude pass decides whether the user's message
// actually expected a reply. Gmail-only for now (mirrors listSentCandidates);
// Outlook is a later follow-up.
export async function listStaleSentThreads(
  client: SupabaseClient,
  userId: string,
): Promise<ScanCandidate[]> {
  const out: ScanCandidate[] = [];
  try {
    const token = await loadGmailAccessToken(client, userId);
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${encodeURIComponent('in:sent older_than:3d newer_than:30d')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (listRes.ok) {
      const list = await listRes.json() as { messages?: Array<{ id: string; threadId: string }> };
      const seen = new Set<string>();
      for (const m of list.messages ?? []) {
        if (seen.has(m.threadId)) continue;
        seen.add(m.threadId);
        const thRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${m.threadId}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!thRes.ok) continue;
        const th = await thRes.json() as {
          messages?: Array<{ labelIds?: string[]; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } }>;
        };
        const msgs = th.messages ?? [];
        if (msgs.length === 0) continue;
        const last = msgs[msgs.length - 1];                  // Gmail returns messages oldest-first
        // Keep only threads where the USER spoke last — a reply would have
        // landed an inbound (non-SENT) message after theirs.
        if (!(last.labelIds ?? []).includes('SENT')) continue;
        const h = (n: string) => last.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? '';
        const dateHeader = h('date');
        out.push({
          thread_id: m.threadId,
          provider: 'google',
          counterparty: h('to'),
          subject: h('subject'),
          latest_text: last.snippet ?? '',
          latest_from: 'user',
          latest_at: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
          kind: 'stale_sent',
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('no google refresh token')) console.warn('[agent-commitments] stale-sent scan (google) failed for', userId, msg);
  }
  return out;
}

// Read current thread state for a commitment's source thread, so Phase 2
// reconcile can close loops that have moved (a sent follow-up resolves you_owe;
// an inbound reply resolves owed_to_you). Gmail-only — the commitment scan only
// produces 'google' rows in v1, so callers skip non-google providers. Any
// failure degrades to expire-only ({null,null}); a transient Gmail blip must not
// crash the whole sweep.
export async function readThreadState(
  token: string,
  threadId: string,
): Promise<ThreadState> {
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=minimal`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return { lastMessageAt: null, lastDirection: null };
    return parseGmailThreadState(await res.json() as GmailThreadMeta);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[agent-commitments] thread-state read failed for', threadId, msg);
    return { lastMessageAt: null, lastDirection: null };
  }
}

// --- Outlook / Graph commitment readers (provider parity with the Gmail ones) ---

const COMMIT_DAY_MS = 24 * 60 * 60 * 1000;

// Graph OData $filter on DateTimeOffset wants no fractional seconds.
function graphFilterTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface GraphSentMsg {
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  sentDateTime?: string;
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
}

function graphSentToCandidate(m: GraphSentMsg, kind: 'sent_recent' | 'stale_sent'): ScanCandidate {
  const to = m.toRecipients?.[0]?.emailAddress;
  return {
    thread_id: m.conversationId ?? '',
    provider: 'microsoft',
    counterparty: to ? (to.name || to.address || '') : '',
    subject: m.subject ?? '',
    latest_text: m.bodyPreview ?? '',
    latest_from: 'user',
    latest_at: m.sentDateTime ?? new Date().toISOString(),
    kind,
  };
}

// Newest message in an Outlook conversation → ThreadState, for Phase 2 reconcile.
export async function readOutlookThreadState(
  token: string,
  conversationId: string,
  ownerAddress: string,
): Promise<ThreadState> {
  try {
    const url =
      `https://graph.microsoft.com/v1.0/me/messages?$filter=conversationId eq '${conversationId}'` +
      `&$orderby=sentDateTime desc&$top=1&$select=from,sentDateTime`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return { lastMessageAt: null, lastDirection: null };
    const j = (await res.json()) as { value?: GraphMessageLite[] };
    return parseGraphThreadState(j.value?.[0], ownerAddress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[agent-commitments] outlook thread-state read failed for', conversationId, msg);
    return { lastMessageAt: null, lastDirection: null };
  }
}

// Recent Outlook sent mail (→ you_owe promises). Graph Sent Items, last 7d, one
// candidate per conversation. Mirrors listSentCandidates; degrades to [] when
// the user has no Microsoft grant.
export async function listOutlookSentCandidates(
  client: SupabaseClient,
  userId: string,
): Promise<ScanCandidate[]> {
  const out: ScanCandidate[] = [];
  try {
    const token = await loadOutlookAccessToken(client, userId);
    if (!token) return out;
    const since = graphFilterTime(Date.now() - 7 * COMMIT_DAY_MS);
    const url =
      `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$top=25` +
      `&$orderby=sentDateTime desc&$filter=${encodeURIComponent(`sentDateTime ge ${since}`)}` +
      `&$select=conversationId,toRecipients,subject,bodyPreview,sentDateTime`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return out;
    const j = (await res.json()) as { value?: GraphSentMsg[] };
    const seen = new Set<string>();
    for (const m of j.value ?? []) {
      const conv = m.conversationId ?? '';
      if (!conv || seen.has(conv)) continue;
      seen.add(conv);
      out.push(graphSentToCandidate(m, 'sent_recent'));
    }
  } catch (err) {
    console.warn('[agent-commitments] sent scan (outlook) failed for', userId, err instanceof Error ? err.message : String(err));
  }
  return out;
}

// Stale "waiting on a reply" Outlook threads (→ owed_to_you). Sent 3–30d ago,
// kept only when the conversation's LATEST message is still the user's own (they
// haven't replied). Mirrors listStaleSentThreads; the SENT-label check becomes a
// from==owner check via readOutlookThreadState.
export async function listOutlookStaleSentThreads(
  client: SupabaseClient,
  userId: string,
): Promise<ScanCandidate[]> {
  const out: ScanCandidate[] = [];
  try {
    const token = await loadOutlookAccessToken(client, userId);
    if (!token) return out;
    const owner = await loadOutlookUserAddress(token);
    if (!owner) return out; // can't tell who spoke last → skip rather than guess
    const now = Date.now();
    const newerThan = graphFilterTime(now - 30 * COMMIT_DAY_MS);
    const olderThan = graphFilterTime(now - 3 * COMMIT_DAY_MS);
    const url =
      `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$top=25` +
      `&$orderby=sentDateTime desc` +
      `&$filter=${encodeURIComponent(`sentDateTime ge ${newerThan} and sentDateTime le ${olderThan}`)}` +
      `&$select=conversationId,toRecipients,subject,bodyPreview,sentDateTime`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return out;
    const j = (await res.json()) as { value?: GraphSentMsg[] };
    const seen = new Set<string>();
    for (const m of j.value ?? []) {
      const conv = m.conversationId ?? '';
      if (!conv || seen.has(conv)) continue;
      seen.add(conv);
      const state = await readOutlookThreadState(token, conv, owner);
      if (state.lastDirection !== 'outbound') continue; // someone replied → not waiting
      out.push(graphSentToCandidate(m, 'stale_sent'));
    }
  } catch (err) {
    console.warn('[agent-commitments] stale-sent scan (outlook) failed for', userId, err instanceof Error ? err.message : String(err));
  }
  return out;
}

// Open commitments for reconcile + nudge.
export async function selectOpenCommitments(
  client: SupabaseClient,
  userId: string,
): Promise<CommitmentRow[]> {
  const { data, error } = await client
    .from('agent_commitments')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'open');
  if (error) throw error;
  return (data ?? []) as CommitmentRow[];
}

// Apply a status/nudge update to one commitment row.
export async function updateCommitment(
  client: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from('agent_commitments').update(patch).eq('id', id);
  if (error) throw error;
}

// Stamp the per-user extraction watermark.
export async function markScanned(client: SupabaseClient, userId: string, nowIso: string): Promise<void> {
  const { error } = await client.from('user_profiles').update({ commitments_scanned_at: nowIso }).eq('user_id', userId);
  if (error) throw error;
}

// Confirmed facts whose follow-up is due and not yet acted. The partial index
// facts_follow_up_due_idx backs this predicate.
export async function selectDueFollowupFacts(
  client: SupabaseClient,
  userId: string,
  nowIso: string,
): Promise<FollowupFactRow[]> {
  const { data, error } = await client
    .from('facts')
    .select('id, text, category, follow_up_at, followed_up_at, status')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .is('followed_up_at', null)
    .not('follow_up_at', 'is', null)
    .lte('follow_up_at', nowIso);
  if (error) throw error;
  return (data ?? []) as FollowupFactRow[];
}

// Stamp followed_up_at so each fact fires exactly once.
export async function markFactsFollowedUp(
  client: SupabaseClient,
  factIds: string[],
  nowIso: string,
): Promise<void> {
  if (factIds.length === 0) return;
  const { error } = await client.from('facts').update({ followed_up_at: nowIso }).in('id', factIds);
  if (error) throw error;
}
