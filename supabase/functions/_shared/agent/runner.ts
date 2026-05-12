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
import type { ExecuteReverseToken } from './tools/dispatch.ts';
import type { ThreadBrief } from './prompt.ts';

import { buildMailTriagePrompt, MAIL_TRIAGE_TOOLS } from './prompt.ts';
import { buildThreadAllowlist, verifyThreadId } from './verify.ts';
import { deriveIdemKey } from './idem.ts';

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
  ) => Promise<{
    reversible: boolean;
    reverseToken: ExecuteReverseToken;
    recordPayload: Record<string, unknown>;
  }>;
  recordAction: (row: RecordActionRow) => Promise<void>;
  incrementBudget: (
    userId: string,
    usage: { input_tokens: number; output_tokens: number },
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
const PHASE_2_ACTIONS = new Set<ActionType>([
  'mail.label',
  'mail.archive',
  'mail.flag_important',
  'mail.summarize',
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
        if (!PHASE_2_ACTIONS.has(action)) {
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
        try {
          const exec = await deps.executeTool(action, input);
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
