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

import type { AgentEventKind, AgentRunTrigger, ActionType } from './types.ts';
import type { CallClaudeResult, ClaudeSystemBlock, ClaudeUserMessage } from './claude.ts';
import type { ExecuteOptions, ExecuteReverseToken } from './tools/dispatch.ts';
import type { ThreadBrief } from './prompt.ts';

import { buildMailTriagePrompt, MAIL_TRIAGE_TOOLS } from './prompt.ts';
import { buildThreadAllowlist, verifyThreadId } from './verify.ts';
import { deriveIdemKey } from './idem.ts';
import { resolvePolicy } from './policy.ts';
import { shouldPushForProposal } from './push.ts';

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

export interface RunnerDeps {
  claimEvents: (userId: string, limit: number) => Promise<ClaimedEvent[]>;
  openRun: (userId: string, trigger: AgentRunTrigger, eventIds: number[]) => Promise<string>;
  finishRun: (
    runId: string,
    status: 'ok' | 'error' | 'budget_exceeded',
    usage?: { input_tokens: number; output_tokens: number },
    error?: string,
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
const MAX_TOOL_ROUNDS = 3;
const SUPPORTED_ACTIONS = new Set<ActionType>([
  'mail.label',
  'mail.archive',
  'mail.flag_important',
  'mail.summarize',
  'mail.draft_reply',
  'mail.send_reply',
]);

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { userId, trigger, deps } = input;

  const events = await deps.claimEvents(userId, CLAIM_BATCH);
  if (events.length === 0) {
    return { runId: null, processed: 0, status: 'ok' };
  }

  const budget = await deps.checkBudget(userId);
  if (budget.exceeded) {
    // Budget guard: don't mark events processed (so they get retried tomorrow),
    // don't open a run row. Surface the status to the caller for logging.
    return { runId: null, processed: 0, status: 'budget_exceeded' };
  }

  const eventIds = events.map((e) => e.id);
  const runId = await deps.openRun(userId, trigger, eventIds);

  let usage = { input_tokens: 0, output_tokens: 0 };
  let runError: string | undefined;

  try {
    const threads = await deps.loadThreadBriefs(userId, events);
    const allow = buildThreadAllowlist(events);
    const userPolicy = await deps.loadUserPolicy(userId);
    const { system, messages } = buildMailTriagePrompt({ threads });
    const conversation: ClaudeUserMessage[] = [...messages];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const turn = await deps.callClaudeTurn(system, conversation, MAIL_TRIAGE_TOOLS);
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

      if (toolUses.length === 0) break;

      const toolResults: Array<Record<string, unknown>> = [];
      for (const tu of toolUses) {
        const action = tu.name as ActionType;
        if (!SUPPORTED_ACTIONS.has(action)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: `unsupported action ${action}`,
          });
          continue;
        }
        const input = (tu.input && typeof tu.input === 'object') ? tu.input : {};
        const threadId = typeof input.thread_id === 'string' ? input.thread_id : '';
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
        // Phase 3: resolve policy. mode='off' rejects.
        // mode='propose' on a currently-auto action (e.g. mail.archive) is
        //   NOT honored as deferred-execute in Phase 3 — the runner still
        //   executes and we treat it as auto. Phase 3.1 will wire deferred
        //   execution via agent-approve dispatching any action. Until then,
        //   the policy slot exists in the UI but only `off` actually blocks
        //   currently-auto actions. For mail.send_reply, dispatcher returns
        //   mode='propose' intrinsically (no provider call), which IS honored.
        const policy = resolvePolicy(action, userPolicy);
        if (policy === 'off') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: `policy_off: user disabled ${action}`,
          });
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
              }
            : undefined;
          const exec = await deps.executeTool(action, input, {
            policy,
            safety,
          });
          if (exec.mode === 'propose') {
            const idemKey = deriveIdemKey(action, exec.recordPayload);
            const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
            const preview = buildProposalPreview(action, exec.recordPayload);
            const proposalId = await deps.writeProposedAction({
              user_id: userId,
              run_id: runId,
              action_type: action,
              payload: { ...exec.recordPayload, idem_key: idemKey },
              preview,
              expires_at: expiresAt,
            });
            const presence = await deps.loadUserPresence(userId);
            if (shouldPushForProposal(presence, new Date())) {
              await deps.dispatchProposalPush(userId, {
                title: typeof preview.title === 'string' ? preview.title : 'Zolva',
                body: typeof preview.body === 'string' ? preview.body : 'Et udkast venter',
                actionId: proposalId,
              });
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: `proposed:${proposalId}`,
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
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'ok',
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
    );
  }

  return {
    runId,
    processed: events.length,
    status: runError ? 'error' : 'ok',
  };
}

function buildProposalPreview(
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
    default:
      return { title: 'Zolva foreslår', body: previewText || `${action}` };
  }
}
