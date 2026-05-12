// supabase/functions/_shared/agent/runner.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { runAgent, RunnerDeps } from './runner.ts';

function makeDeps(): { deps: RunnerDeps; log: string[] } {
  const log: string[] = [];
  return {
    log,
    deps: {
      claimEvents: async (userId, limit) => {
        log.push(`claim ${userId} ${limit}`);
        return [
          { id: 1, kind: 'mail.new', payload: { thread_id: 'a' } },
          { id: 2, kind: 'mail.new', payload: { thread_id: 'b' } },
        ];
      },
      openRun: async (userId, trigger, eventIds) => {
        log.push(`open ${userId} ${trigger} ${eventIds.join(',')}`);
        return 'run-1';
      },
      finishRun: async (runId, status) => {
        log.push(`finish ${runId} ${status}`);
      },
      markProcessed: async (eventIds) => {
        log.push(`processed ${eventIds.join(',')}`);
      },
    },
  };
}

Deno.test('runAgent: no-op orchestration writes a run and marks events', async () => {
  const { deps, log } = makeDeps();
  const result = await runAgent({
    userId: 'u-1',
    trigger: 'tick',
    deps,
  });
  assertEquals(result, { runId: 'run-1', processed: 2, status: 'ok' });
  assertEquals(log, [
    'claim u-1 50',
    'open u-1 tick 1,2',
    'processed 1,2',
    'finish run-1 ok',
  ]);
});

Deno.test('runAgent: when there are no events, do not open a run', async () => {
  const { deps, log } = makeDeps();
  deps.claimEvents = async () => [];
  const result = await runAgent({
    userId: 'u-1',
    trigger: 'tick',
    deps,
  });
  assertEquals(result, { runId: null, processed: 0, status: 'ok' });
  assertEquals(log, []); // openRun should not have fired
});
