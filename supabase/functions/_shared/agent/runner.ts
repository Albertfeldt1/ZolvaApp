// supabase/functions/_shared/agent/runner.ts
//
// Phase-2 mail-triage runner. Claims events, loads thread context, calls
// Claude with the four-tool catalog, executes any tool_use blocks server-
// side through the dispatcher, writes one agent_actions row per executed
// tool, and finishes the run with usage totals.
//
// The runner is the integration seam between agent-tick (which provides
// concrete deps backed by Supabase + Gmail + Anthropic) and the pure-logic
// modules (policy, idem, verify, prompt, tools/dispatch). All side-effects
// live behind RunnerDeps so unit tests can stub them.

import { ACTION_DEFAULT_MODE } from './types.ts';
import type { AgentEventKind, AgentRunTrigger, ActionType } from './types.ts';
import type { CallClaudeResult, ClaudeSystemBlock, ClaudeUserMessage } from './claude.ts';
import type { ExecuteOptions, ExecuteReverseToken } from './tools/dispatch.ts';
import type { ThreadBrief } from './prompt.ts';

import { actionTypeFromToolName, buildMailTriagePrompt, MAIL_TRIAGE_TOOLS, REFLECT_TOOLS, buildReflectPrompt, buildCommitmentScanPrompt, COMMITMENT_SCAN_TOOLS } from './prompt.ts';
import type { ScanCandidate } from './prompt.ts';
import { resolveDue } from './commitments.ts';
import { buildThreadAllowlist, verifyThreadId } from './verify.ts';
import { deriveIdemKey } from './idem.ts';
import { resolvePolicy } from './policy.ts';
import { shouldPushForProposal } from './push.ts';

// A run strategy supplies the parts that differ between the mail-triage path
// (agent-tick) and the reflect path (agent-reflect). Everything else — the
// Claude loop, dispatch, idem, budget, trace — lives in executeRun and is shared.
export interface AgentStrategy {
  // Per-run system + user messages and the tool catalogue for this path.
  buildContext: (
    userId: string,
    events: ClaimedEvent[],
    deps: RunnerDeps,
  ) => Promise<{
    system: ClaudeSystemBlock[];
    messages: ClaudeUserMessage[];
    tools: ReadonlyArray<unknown>;
    // Mail-triage carries the source-from/source-body resolvers + the body map
    // (mutated by the mail.get_body context branch). Reflect omits these — the
    // `?.` call sites then yield undefined, identical to today's "no source" path.
    resolveSourceFrom?: (p: Record<string, unknown>) => string | undefined;
    resolveSourceBody?: (p: Record<string, unknown>) => string | undefined;
    _sourceBodyByThread?: Map<string, string>;
  }>;
  // Seed the readable-thread allowlist. mail-triage: the triggering threads.
  // reflect: empty (grown by mail_search).
  seedAllowlist: (events: ClaimedEvent[]) => Set<string>;
  // After a context tool returns, thread_ids to add to the allowlist.
  // reflect uses this for mail.search; mail-triage returns [].
  extendAllowlist: (action: ActionType, recordPayload: Record<string, unknown>) => string[];
}

export interface ClaimedEvent {
  id: number;
  kind: AgentEventKind;
  payload: Record<string, unknown>;
}

export interface RecordActionRow {
  user_id: string;
  run_id: string;
  action_type: ActionType;
  payload: Record<string, unknown>; // includes idem_key
  reversible: boolean;
  reverse_token: ExecuteReverseToken;
}

export interface RunTraceTurn {
  round: number;
  stop_reason: string;
  text: string;
  tools: Array<{ name: string; thread_id: string | null }>;
  // Outcome of each tool call this round — the verbatim tool_result fed back
  // to Claude. is_error=true means executeTool threw (provider 4xx, dup idem,
  // policy_off, etc). This is what tells us WHY a tool failed.
  results?: Array<{ name: string | null; is_error: boolean; content: string }>;
}

export interface RunnerDeps {
  claimEvents: (userId: string, limit: number) => Promise<ClaimedEvent[]>;
  openRun: (userId: string, trigger: AgentRunTrigger, eventIds: number[]) => Promise<string>;
  finishRun: (
    runId: string,
    status: 'ok' | 'error' | 'budget_exceeded',
    usage?: { input_tokens: number; output_tokens: number },
    error?: string,
    // Compact per-turn trace for observability: stop_reason, the assistant's
    // text, and which tools it called each round. Lets us see WHY a run took
    // no action without storing the full transcript.
    trace?: RunTraceTurn[],
  ) => Promise<void>;
  markProcessed: (eventIds: number[]) => Promise<void>;
  // Phase-2 deps.
  checkBudget: (userId: string) => Promise<{ exceeded: boolean }>;
  loadThreadBriefs: (userId: string, events: ClaimedEvent[]) => Promise<ThreadBrief[]>;
  callClaudeTurn: (
    system: ClaudeSystemBlock[],
    messages: ClaudeUserMessage[],
    tools: ReadonlyArray<unknown>,
  ) => Promise<CallClaudeResult>;
  executeTool: (
    action: ActionType,
    payload: Record<string, unknown>,
    opts?: ExecuteOptions,
  ) => Promise<{
    mode: 'executed' | 'propose';
    reversible: boolean;
    reverseToken: ExecuteReverseToken;
    recordPayload: Record<string, unknown>;
  }>;
  recordAction: (row: RecordActionRow) => Promise<void>;
  incrementBudget: (
    userId: string,
    usage: { input_tokens: number; output_tokens: number },
  ) => Promise<void>;
  // Phase 3 deps
  loadUserPolicy: (userId: string) => Promise<Array<{ user_id: string; action_type: ActionType; mode: 'auto' | 'propose' | 'off' }>>;
  loadUserPresence: (userId: string) => Promise<Date | null>;
  // Phase 3.1 safety deps — only consulted on mail.send_reply with policy=auto.
  isUserIdle: (userId: string, now: Date) => Promise<boolean>;
  recipientAllowlistCheck: (userId: string, address: string) => Promise<boolean>;
  priorFailedSendIdem: (userId: string, idemKey: string) => Promise<boolean>;
  writeProposedAction: (row: {
    user_id: string;
    run_id: string;
    action_type: ActionType;
    payload: Record<string, unknown>;
    preview: Record<string, unknown>;
    expires_at: string;
  }) => Promise<string>;
  dispatchProposalPush: (
    userId: string,
    preview: { title: string; body: string; actionId: string },
  ) => Promise<void>;
  // Phase 4 trust-escalation: accepted per-recipient promotions.
  // Loaded once per run alongside loadUserPolicy.
  loadActivePromotions: (userId: string) => Promise<Array<{ action_type: string; recipient: string }>>;
  // Phase 4 nudge.push: record the action (idem-gated) AND send the push in one
  // atomic step. Returns { sent:false } when the agent_actions insert collided
  // on the daily idem key — i.e. this topic was already nudged today — so the
  // runner can tell Claude not to retry rather than double-notifying the user.
  fireNudge: (args: {
    user_id: string;
    run_id: string;
    payload: Record<string, unknown>;
    title: string;
    body: string;
    data: Record<string, unknown>;
  }) => Promise<{ sent: boolean }>;
  // Commitment tracking: upsert one extracted commitment into agent_commitments
  // on the (user_id, thread_id, direction) dedup key. Returns whether the row
  // was newly inserted or an existing one updated (for trace/metrics only).
  recordCommitment: (
    userId: string,
    runId: string,
    commitment: Record<string, unknown>,
  ) => Promise<'inserted' | 'updated'>;
}

export interface RunInput {
  userId: string;
  trigger: AgentRunTrigger;
  deps: RunnerDeps;
}

export interface RunResult {
  runId: string | null;
  processed: number;
  status: 'ok' | 'error' | 'budget_exceeded';
}

const CLAIM_BATCH = 50;
// The research→draft→propose flow needs: mail_get_body, cal_list_events
// (and/or drive_search), mail_draft_reply, mail_send_reply — already 4 rounds
// for a single thread. 3 was too tight: the chain ran out before it could
// propose, so a drafted reply never surfaced as an approve-card. 6 leaves
// headroom for one research detour without unbounded looping.
const MAX_TOOL_ROUNDS = 6;
const SUPPORTED_ACTIONS = new Set<ActionType>([
  'mail.label',
  'mail.archive',
  'mail.flag_important',
  'mail.summarize',
  'mail.draft_reply',
  'mail.send_reply',
  'mail.get_body',
  'mail.search',
  'cal.list_events',
  'drive.search',
  'cal.create_event',
  'cal.update_event',
  'nudge.push',
  'commitment.record',
]);
// Read-only context tools (Phase 4a). These never produce an agent_actions
// row — they exist purely to feed Claude richer context within the run, so
// idem/recordAction don't apply. The dispatcher still returns recordPayload
// (used as the tool_result content sent back to Claude).
const CONTEXT_ONLY_ACTIONS = new Set<ActionType>([
  'mail.get_body',
  'mail.search',
  'cal.list_events',
  'drive.search',
]);
// Context tools that are NOT thread-scoped — their inputs carry no thread_id
// (cal.list_events takes start/end, drive.search takes a query). The thread
// hallucination-guard must be skipped for them, or it throws on the empty
// thread_id and the call dies before it runs. (mail.get_body IS thread-scoped
// and still goes through the guard.)
const NON_THREAD_ACTIONS = new Set<ActionType>([
  'mail.search',
  'cal.list_events',
  'drive.search',
  'cal.create_event',
  'cal.update_event',
  // nudge.push carries no thread_id (it has action_kind + target_id). Running
  // the thread guard on it would throw on the empty thread_id and kill the call.
  'nudge.push',
  // commitment.record carries thread_id as data, not as a read target — it must
  // skip the thread hallucination guard.
  'commitment.record',
]);

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { userId, trigger, deps } = input;

  // Budget guard BEFORE claiming. claimEvents sets batch_id to lock rows, and
  // a budget-exceeded early return never releases that lock — so claiming
  // first would strand the batch permanently (batch_id set, never re-claimed,
  // never processed). Checking first leaves the events unclaimed for tomorrow.
  const budget = await deps.checkBudget(userId);
  if (budget.exceeded) {
    return { runId: null, processed: 0, status: 'budget_exceeded' };
  }

  const events = await deps.claimEvents(userId, CLAIM_BATCH);
  if (events.length === 0) {
    return { runId: null, processed: 0, status: 'ok' };
  }

  return executeRun(userId, trigger, events, deps, mailTriageStrategy);
}

// Path-agnostic engine: openRun → context (via strategy) → Claude tool loop
// (dispatch, idem, budget, trace) → finishRun. The only path-specific bits are
// supplied by `strategy`: how context/prompt is built, which tools are offered,
// and the readable-thread allowlist model.
async function executeRun(
  userId: string,
  trigger: AgentRunTrigger,
  events: ClaimedEvent[],
  deps: RunnerDeps,
  strategy: AgentStrategy,
): Promise<RunResult> {
  const eventIds = events.map((e) => e.id);
  const runId = await deps.openRun(userId, trigger, eventIds);

  let usage = { input_tokens: 0, output_tokens: 0 };
  let runError: string | undefined;
  const trace: RunTraceTurn[] = [];

  try {
    const allow = strategy.seedAllowlist(events);
    const userPolicy = await deps.loadUserPolicy(userId);
    const promotions = await deps.loadActivePromotions(userId);
    const ctx = await strategy.buildContext(userId, events, deps);
    const { system, messages, tools } = ctx;
    const conversation: ClaudeUserMessage[] = [...messages];

    // Per-run set of thread_ids the agent has opened with mail.get_body.
    // Consulted by the mail.send_reply safety rail so we never auto-send a
    // reply off the snippet alone. Resets every run (scoped inside the try).
    const researchedThreads = new Set<string>();
    // Per-run bridge: a mail.draft_reply step records the full reply body +
    // headers; the later mail.send_reply proposal needs them (for the approval
    // UI to show/edit the real text, and for the edited-send path to have
    // subject + in_reply_to). Keyed by draft_id.
    const draftDetail = new Map<string, { body_full?: string; subject?: string; in_reply_to_message_id?: string }>();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const turn = await deps.callClaudeTurn(system, conversation, tools);
      usage = {
        input_tokens: usage.input_tokens + turn.usage.input_tokens,
        output_tokens: usage.output_tokens + turn.usage.output_tokens,
      };

      const toolUses = turn.content.filter((b) => b.type === 'tool_use') as Array<{
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;

      // Always push the assistant turn (text + tool_use) onto the conversation
      // so a follow-up Claude call has the context if we need to loop.
      conversation.push({ role: 'assistant', content: turn.content });

      // Record this turn for observability before we act on (or bail from) it.
      const turnText = turn.content
        .filter((b) => b.type === 'text')
        .map((b) => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
        .join(' ')
        .trim();
      trace.push({
        round,
        stop_reason: turn.stop_reason,
        text: turnText.slice(0, 500),
        tools: toolUses.map((tu) => ({
          name: tu.name,
          thread_id: typeof tu.input?.thread_id === 'string' ? tu.input.thread_id : null,
        })),
      });

      if (toolUses.length === 0) break;

      const toolResults: Array<Record<string, unknown>> = [];
      for (const tu of toolUses) {
        const action = actionTypeFromToolName(tu.name);
        if (!action || !SUPPORTED_ACTIONS.has(action)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: `unsupported action ${tu.name}`,
          });
          continue;
        }
        const input = (tu.input && typeof tu.input === 'object') ? tu.input : {};
        const threadId = typeof input.thread_id === 'string' ? input.thread_id : '';
        // Thread guard applies only to thread-scoped tools. cal.list_events /
        // drive.search carry no thread_id; running the guard on them throws
        // 'unknown thread' on the empty id and kills the call (Phase 4a bug).
        if (!NON_THREAD_ACTIONS.has(action)) {
          try {
            verifyThreadId(threadId, allow);
          } catch (e) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              is_error: true,
              content: String(e instanceof Error ? e.message : e),
            });
            continue;
          }
        }
        // Phase 3 + 3.1: resolve policy. mode='off' rejects. mode='propose'
        // on a currently-auto action (mail.archive etc.) is honored via the
        // deferred-execute branch below — runner writes a proposal, agent-
        // approve dispatches when the user taps Send. For mail.send_reply,
        // the dispatcher already returns mode='propose' intrinsically unless
        // policy=auto + every safety rail holds.
        const recipient =
          action === 'mail.send_reply' && typeof input.to === 'string'
            ? input.to
            : undefined;
        const policy = resolvePolicy(action, userPolicy, {
          recipient,
          promotions,
        });
        if (policy === 'off') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: `policy_off: user disabled ${action}`,
          });
          continue;
        }
        // Phase 3.1 deferred-execute: user override flipped a currently-auto
        // action (e.g. mail.archive) to propose. Write a proposed_actions row
        // with the raw Claude input instead of executing — agent-approve will
        // dispatch via executeTool when the user taps Send.
        const defaultMode = ACTION_DEFAULT_MODE[action];
        if (policy === 'propose' && defaultMode === 'auto') {
          try {
            const idemKey = deriveIdemKey(action, input);
            const sourceFrom = ctx.resolveSourceFrom?.(input);
            const sourceBody = ctx.resolveSourceBody?.(input);
            await writeProposalAndMaybePush(deps, {
              userId,
              runId,
              action,
              payload: { ...input, idem_key: idemKey, deferred_execute: true, ...(sourceFrom ? { source_from: sourceFrom } : {}), ...(sourceBody ? { source_body: sourceBody } : {}) },
              toolUseId: tu.id,
              toolResults,
              fallbackPushBody: 'En handling venter',
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(
              `[runner] deferred-execute proposal failed user=${userId} run=${runId} action=${action}: ${msg}`,
            );
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              is_error: true,
              content: msg,
            });
          }
          continue;
        }
        try {
          // Only build the safety context when it's actually consulted —
          // mail.send_reply is the only auto-eligible action that uses it
          // today, and isUserIdle / recipient check both hit Supabase.
          const needsSafety = action === 'mail.send_reply' && policy === 'auto';
          const safety = needsSafety
            ? {
                userIsIdle: await deps.isUserIdle(userId, new Date()),
                hasRecipientHistory: (addr: string) =>
                  deps.recipientAllowlistCheck(userId, addr),
                hasPriorFailedIdem: (idem: string) =>
                  deps.priorFailedSendIdem(userId, idem),
                threadWasResearched: (tid: string) => researchedThreads.has(tid),
              }
            : undefined;
          const exec = await deps.executeTool(action, input, {
            policy,
            safety,
          });
          if (exec.mode === 'propose') {
            const idemKey = deriveIdemKey(action, exec.recordPayload);
            // Splice the full reply body + headers captured from the draft_reply
            // step into the send_reply proposal. exec.recordPayload wins on any
            // overlapping key (e.g. `to`).
            const carried =
              action === 'mail.send_reply' && typeof exec.recordPayload.draft_id === 'string'
                ? draftDetail.get(exec.recordPayload.draft_id)
                : undefined;
            const sourceFrom = ctx.resolveSourceFrom?.(exec.recordPayload);
            const sourceBody = ctx.resolveSourceBody?.(exec.recordPayload);
            await writeProposalAndMaybePush(deps, {
              userId,
              runId,
              action,
              payload: { ...(carried ?? {}), ...exec.recordPayload, idem_key: idemKey, ...(sourceFrom ? { source_from: sourceFrom } : {}), ...(sourceBody ? { source_body: sourceBody } : {}) },
              toolUseId: tu.id,
              toolResults,
              fallbackPushBody: 'Et udkast venter',
            });
            continue;
          }
          // Context-only tools (mail.get_body / cal.list_events / drive.search)
          // skip idem + recordAction — they produce no audit-worthy side
          // effect — and instead pass the dispatcher's recordPayload back to
          // Claude as the tool_result content for in-run grounding.
          if (CONTEXT_ONLY_ACTIONS.has(action)) {
            if (action === 'mail.get_body') {
              const tid = typeof input.thread_id === 'string' ? input.thread_id : '';
              if (tid) {
                researchedThreads.add(tid);
                const bodyText = typeof exec.recordPayload.body_text === 'string' ? exec.recordPayload.body_text : '';
                if (bodyText) ctx._sourceBodyByThread?.set(tid, bodyText.slice(0, 4000));
              }
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(exec.recordPayload),
            });
            for (const tid of strategy.extendAllowlist(action, exec.recordPayload)) allow.add(tid);
            continue;
          }
          // nudge.push: record-then-send, gated by the daily idem key. fireNudge
          // inserts the agent_actions row first; only a fresh insert sends the
          // push, so a topic already nudged today (idem collision) returns
          // sent:false and we tell Claude to stop instead of double-notifying.
          if (action === 'nudge.push') {
            const day = copenhagenDay(new Date());
            const idemKey = deriveIdemKey(action, { ...exec.recordPayload, day });
            const actionKind = typeof exec.recordPayload.action_kind === 'string' ? exec.recordPayload.action_kind : '';
            const targetId = typeof exec.recordPayload.target_id === 'string' ? exec.recordPayload.target_id : '';
            const { sent } = await deps.fireNudge({
              user_id: userId,
              run_id: runId,
              payload: { ...exec.recordPayload, day, idem_key: idemKey },
              title: typeof exec.recordPayload.title === 'string' ? exec.recordPayload.title : '',
              body: typeof exec.recordPayload.body === 'string' ? exec.recordPayload.body : '',
              data: { type: 'nudge', action_kind: actionKind, target_id: targetId },
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: sent ? 'nudge_sent' : 'rate_limited: already nudged this topic today',
            });
            continue;
          }
          // Execute path (unchanged from Phase 2)
          const idemKey = deriveIdemKey(action, exec.recordPayload);
          const payloadWithKey = { ...exec.recordPayload, idem_key: idemKey };
          await deps.recordAction({
            user_id: userId,
            run_id: runId,
            action_type: action,
            payload: payloadWithKey,
            reversible: exec.reversible,
            reverse_token: exec.reverseToken,
          });
          if (action === 'mail.draft_reply' && typeof exec.recordPayload.draft_id === 'string') {
            draftDetail.set(exec.recordPayload.draft_id, {
              body_full: typeof exec.recordPayload.body_full === 'string' ? exec.recordPayload.body_full : undefined,
              subject: typeof exec.recordPayload.subject === 'string' ? exec.recordPayload.subject : undefined,
              in_reply_to_message_id: typeof exec.recordPayload.in_reply_to_message_id === 'string' ? exec.recordPayload.in_reply_to_message_id : undefined,
            });
          }
          // mail.draft_reply must hand its real draft_id + draft_hash back to
          // Claude so the follow-up mail.send_reply references the actual draft
          // (not a hallucinated id). Other actions just need an ack.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: action === 'mail.draft_reply'
              ? JSON.stringify(exec.recordPayload)
              : 'ok',
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(
            `[runner] tool ${action} failed user=${userId} run=${runId} thread=${threadId}: ${msg}`,
          );
          // Duplicate idem_key (uniq index 409) and provider 4xx land here.
          // Surface to Claude so it doesn't retry the same call this round.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: msg,
          });
        }
      }

      // Attach this round's tool outcomes to the trace turn recorded above.
      const idToName = new Map(toolUses.map((tu) => [tu.id, tu.name]));
      trace[trace.length - 1].results = toolResults.map((r) => ({
        name: (idToName.get(r.tool_use_id as string) ?? null) as string | null,
        is_error: r.is_error === true,
        content: (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)).slice(0, 300),
      }));

      conversation.push({ role: 'user', content: toolResults });

      if (turn.stop_reason !== 'tool_use') break;
    }
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  }

  try {
    await deps.markProcessed(eventIds);
    await deps.incrementBudget(userId, usage);
  } catch (e) {
    // Don't lose finishRun if a teardown call fails. Surface in the run row.
    const msg = e instanceof Error ? e.message : String(e);
    runError = runError ? `${runError}; teardown: ${msg}` : `teardown: ${msg}`;
    console.error(`[runner] teardown failure for run ${runId}:`, msg);
  } finally {
    await deps.finishRun(
      runId,
      runError ? 'error' : 'ok',
      usage,
      runError,
      trace,
    );
  }

  return {
    runId,
    processed: events.length,
    status: runError ? 'error' : 'ok',
  };
}

// Mail-triage path (agent-tick): builds context from the triggering threads'
// briefs, offers the full MAIL_TRIAGE_TOOLS catalogue, and seeds the allowlist
// from the claimed mail.new events. The allowlist is fixed (no growth).
export const mailTriageStrategy: AgentStrategy = {
  async buildContext(userId, events, deps) {
    const threads = await deps.loadThreadBriefs(userId, events);
    // Sender of each triggering thread, surfaced on proposals as `source_from`
    // so the approval UI can show who the proposal is about. Calendar proposals
    // carry no thread_id, so fall back to the sole thread's sender when the run
    // is about a single thread (the common case).
    const senderByThread = new Map<string, string>();
    for (const t of threads) if (t.from) senderByThread.set(t.thread_id, t.from);
    const soleSender = threads.length === 1 ? (threads[0].from ?? undefined) : undefined;
    // Original incoming message body, captured from mail_get_body, keyed by
    // thread_id. Surfaced on proposals as `source_body`. Capped to bound size.
    const sourceBodyByThread = new Map<string, string>(); // populated by mail.get_body in the loop
    const resolveSourceFrom = (payload: Record<string, unknown>): string | undefined => {
      const tid = typeof payload.thread_id === 'string' ? payload.thread_id : '';
      return (tid && senderByThread.get(tid)) || soleSender;
    };
    const resolveSourceBody = (payload: Record<string, unknown>): string | undefined => {
      const tid = typeof payload.thread_id === 'string' ? payload.thread_id : '';
      if (tid && sourceBodyByThread.has(tid)) return sourceBodyByThread.get(tid);
      // Non-thread proposals (e.g. cal.create_event) — fall back to the sole
      // researched body when the run read exactly one thread.
      return sourceBodyByThread.size === 1 ? [...sourceBodyByThread.values()][0] : undefined;
    };
    const { system, messages } = buildMailTriagePrompt({ threads, nowIso: new Date().toISOString() });
    return { system, messages, tools: MAIL_TRIAGE_TOOLS, resolveSourceFrom, resolveSourceBody, _sourceBodyByThread: sourceBodyByThread };
  },
  seedAllowlist: (events) => buildThreadAllowlist(events),
  extendAllowlist: () => [],
};

export interface RunReflectInput {
  userId: string;
  events: ClaimedEvent[]; // already-claimed calendar.upcoming rows
  deps: RunnerDeps;
}

// Reflect path (agent-reflect): builds context from upcoming calendar events,
// offers only the read+nudge catalogue (REFLECT_TOOLS), and seeds an EMPTY
// thread allowlist — the agent may only read threads that mail_search returned
// this run (extendAllowlist grows the set from each mail.search result).
export const reflectStrategy: AgentStrategy = {
  async buildContext(_userId, events, _deps) {
    const reflectEvents = events.map((e) => ({
      event_id: String(e.payload.event_id ?? ''),
      provider: (e.payload.provider === 'microsoft' ? 'microsoft' : 'google') as 'google' | 'microsoft',
      title: String(e.payload.title ?? ''),
      start: String(e.payload.start ?? ''),
      location: typeof e.payload.location === 'string' ? e.payload.location : undefined,
      attendees: Array.isArray(e.payload.attendees) ? (e.payload.attendees as unknown[]).filter((a): a is string => typeof a === 'string') : undefined,
      description: typeof e.payload.description === 'string' ? e.payload.description : undefined,
    }));
    const { system, messages } = buildReflectPrompt({ events: reflectEvents, nowIso: new Date().toISOString() });
    return { system, messages, tools: REFLECT_TOOLS };
  },
  seedAllowlist: () => new Set<string>(),
  // A legitimate mail_get_body has a hard data dependency on a prior mail_search:
  // Claude cannot know a real thread_id until the search result returns (a later
  // round). So if mail_get_body is ever batched in the SAME round as the search
  // that would "discover" the thread, the id was necessarily guessed — and the
  // empty-seed allowlist correctly rejects it. The grow-from-search model is
  // therefore safe by data dependency, not just by ordering luck.
  extendAllowlist: (action, recordPayload) => {
    if (action !== 'mail.search') return [];
    const hits = Array.isArray(recordPayload.hits) ? recordPayload.hits : [];
    return hits.map((h) => (h && typeof h === 'object' ? String((h as { thread_id?: unknown }).thread_id ?? '') : '')).filter(Boolean);
  },
};

export async function runReflect(input: RunReflectInput): Promise<RunResult> {
  const { userId, events, deps } = input;
  const budget = await deps.checkBudget(userId);
  if (budget.exceeded) return { runId: null, processed: 0, status: 'budget_exceeded' };
  if (events.length === 0) return { runId: null, processed: 0, status: 'ok' };
  return executeRun(userId, 'reflect.sweep', events, deps, reflectStrategy);
}

export interface CommitmentScanInput {
  userId: string;
  candidates: ScanCandidate[];
  deps: RunnerDeps;
}

const SCAN_MAX_ROUNDS = 3;

// Extraction loop: prompt Claude with the candidate sent-threads, execute each
// commitment_record tool call by shaping it (dispatch) + upserting it
// (deps.recordCommitment). No idem-as-action, no allowlist — the only tool is a
// write to our own table, keyed by its own (user,thread,direction) uniqueness.
export async function runCommitmentScan(input: CommitmentScanInput): Promise<RunResult> {
  const { userId, candidates, deps } = input;
  const budget = await deps.checkBudget(userId);
  if (budget.exceeded) return { runId: null, processed: 0, status: 'budget_exceeded' };
  if (candidates.length === 0) return { runId: null, processed: 0, status: 'ok' };

  const runId = await deps.openRun(userId, 'commitments.scan', []);
  let usage = { input_tokens: 0, output_tokens: 0 };
  let runError: string | undefined;
  const trace: RunTraceTurn[] = [];

  try {
    const candidateByThread = new Map(candidates.map((c) => [c.thread_id, c]));
    const { system, messages } = buildCommitmentScanPrompt({ candidates, nowIso: new Date().toISOString() });
    const conversation: ClaudeUserMessage[] = [...messages];

    for (let round = 0; round < SCAN_MAX_ROUNDS; round++) {
      const turn = await deps.callClaudeTurn(system, conversation, COMMITMENT_SCAN_TOOLS);
      usage = {
        input_tokens: usage.input_tokens + turn.usage.input_tokens,
        output_tokens: usage.output_tokens + turn.usage.output_tokens,
      };
      const toolUses = turn.content.filter((b) => b.type === 'tool_use') as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;
      conversation.push({ role: 'assistant', content: turn.content });
      trace.push({ round, stop_reason: turn.stop_reason, text: '', tools: toolUses.map((t) => ({ name: t.name, thread_id: typeof t.input?.thread_id === 'string' ? t.input.thread_id : null })) });
      if (toolUses.length === 0) break;

      const toolResults: Array<Record<string, unknown>> = [];
      for (const tu of toolUses) {
        const action = actionTypeFromToolName(tu.name);
        if (action !== 'commitment.record') {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `unsupported ${tu.name}` });
          continue;
        }
        try {
          const exec = await deps.executeTool('commitment.record', tu.input ?? {});
          const threadId = typeof exec.recordPayload.thread_id === 'string' ? exec.recordPayload.thread_id : '';
          const anchor = candidateByThread.get(threadId)?.latest_at ?? new Date().toISOString();
          const { dueAt, inferred } = resolveDue(
            exec.recordPayload.direction as 'you_owe' | 'owed_to_you',
            typeof exec.recordPayload.due_at === 'string' ? exec.recordPayload.due_at : null,
            anchor,
          );
          const outcome = await deps.recordCommitment(userId, runId, {
            ...exec.recordPayload,
            due_at: dueAt,
            due_inferred: inferred,
            last_message_at: anchor,
          });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: outcome });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: msg });
        }
      }
      conversation.push({ role: 'user', content: toolResults });
      if (turn.stop_reason !== 'tool_use') break;
    }
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  }

  try { await deps.incrementBudget(userId, usage); } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runError = runError ? `${runError}; budget: ${msg}` : `budget: ${msg}`;
  } finally {
    await deps.finishRun(runId, runError ? 'error' : 'ok', usage, runError, trace);
  }
  return { runId, processed: candidates.length, status: runError ? 'error' : 'ok' };
}

// Europe/Copenhagen calendar day as YYYY-MM-DD. Used as the day component of
// the nudge.push idem key so the daily rate limit rolls over at local midnight
// (matching the user's sense of "today"), not UTC midnight.
function copenhagenDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function buildProposalPreview(
  action: ActionType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const previewText = typeof payload.preview_text === 'string' ? payload.preview_text : '';
  switch (action) {
    case 'mail.send_reply':
      return {
        title: 'Send svar?',
        body: previewText || 'Zolva har udkastet et svar — godkend for at sende.',
        thread_id: payload.thread_id,
        draft_id: payload.draft_id,
      };
    case 'cal.create_event': {
      const title = typeof payload.title === 'string' ? payload.title : 'begivenhed';
      const when = typeof payload.start_iso === 'string' ? payload.start_iso : '';
      return { title: 'Opret begivenhed?', body: when ? `${title} · ${when}` : title };
    }
    case 'cal.update_event': {
      const parts: string[] = [];
      if (typeof payload.start_iso === 'string') parts.push(`ny tid ${payload.start_iso}`);
      if (typeof payload.title === 'string') parts.push(`ny titel ${payload.title}`);
      if (typeof payload.location === 'string') parts.push(`nyt sted ${payload.location}`);
      return { title: 'Ret begivenhed?', body: parts.join(' · ') || 'Opdatér begivenhed' };
    }
    default:
      return { title: 'Zolva foreslår', body: previewText || `${action}` };
  }
}

// Shared proposal-write path used by both deferred-execute (currently-auto
// action flipped to propose) and the mail.send_reply propose branch from the
// dispatcher. Caller is responsible for embedding `idem_key` (and any flags
// like `deferred_execute: true`) into `payload` before calling.
async function writeProposalAndMaybePush(
  deps: RunnerDeps,
  args: {
    userId: string;
    runId: string;
    action: ActionType;
    payload: Record<string, unknown>;
    toolUseId: string;
    toolResults: Array<Record<string, unknown>>;
    fallbackPushBody: string;
  },
): Promise<void> {
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const preview = buildProposalPreview(args.action, args.payload);
  const proposalId = await deps.writeProposedAction({
    user_id: args.userId,
    run_id: args.runId,
    action_type: args.action,
    payload: args.payload,
    preview,
    expires_at: expiresAt,
  });
  const presence = await deps.loadUserPresence(args.userId);
  if (shouldPushForProposal(presence, new Date())) {
    await deps.dispatchProposalPush(args.userId, {
      title: typeof preview.title === 'string' ? preview.title : 'Zolva',
      body: typeof preview.body === 'string' ? preview.body : args.fallbackPushBody,
      actionId: proposalId,
    });
  }
  args.toolResults.push({
    type: 'tool_result',
    tool_use_id: args.toolUseId,
    content: `proposed:${proposalId}`,
  });
}
