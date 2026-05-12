// supabase/functions/_shared/agent/runner.ts
import { AgentEventKind, AgentRunTrigger } from './types.ts';

export interface ClaimedEvent {
  id: number;
  kind: AgentEventKind;
  payload: Record<string, unknown>;
}

export interface RunnerDeps {
  claimEvents: (userId: string, limit: number) => Promise<ClaimedEvent[]>;
  openRun: (
    userId: string,
    trigger: AgentRunTrigger,
    eventIds: number[],
  ) => Promise<string>;
  finishRun: (runId: string, status: 'ok' | 'error' | 'budget_exceeded') => Promise<void>;
  markProcessed: (eventIds: number[]) => Promise<void>;
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

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { userId, trigger, deps } = input;
  const events = await deps.claimEvents(userId, CLAIM_BATCH);
  if (events.length === 0) {
    return { runId: null, processed: 0, status: 'ok' };
  }
  const eventIds = events.map((e) => e.id);
  const runId = await deps.openRun(userId, trigger, eventIds);
  // Phase-1 no-op: no Claude call, no tool execution.
  await deps.markProcessed(eventIds);
  await deps.finishRun(runId, 'ok');
  return { runId, processed: events.length, status: 'ok' };
}
