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
      // Phase-2 deps — default no-ops keep the legacy "no-op orchestration"
      // tests above passing.
      checkBudget: async () => ({ exceeded: false }),
      loadThreadBriefs: async () => [],
      callClaudeTurn: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      }),
      executeTool: async () => ({
        reversible: false,
        reverseToken: null,
        recordPayload: {},
      }),
      recordAction: async () => {},
      incrementBudget: async () => {},
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

// Phase-2 path: Claude returns one mail.archive tool_use; runner executes
// it via the stubbed dispatcher and records an action.
import { CallClaudeResult } from './claude.ts';

Deno.test('runAgent: phase-2 path executes one tool call', async () => {
  let claudeCalls = 0;
  let recordedAction: { action_type: string; payload: Record<string, unknown> } | null = null as { action_type: string; payload: Record<string, unknown> } | null;
  const claudeResponses: CallClaudeResult[] = [
    {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'mail.archive',
          input: { thread_id: 't1' },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: 'tool_use',
    },
    {
      content: [{ type: 'text', text: 'Arkiveret 1 tråd.' }],
      usage: { input_tokens: 10, output_tokens: 8 },
      stop_reason: 'end_turn',
    },
  ];

  const { deps, log } = makeDeps();
  // Provide a single mail.new event so the prompt has a thread.
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Faktura', snippet: '' },
  ];
  deps.callClaudeTurn = async (_sys, _msgs, _tools) => {
    return claudeResponses[claudeCalls++];
  };
  deps.executeTool = async (action, payload) => {
    return {
      reversible: true,
      reverseToken: { kind: 'gmail.modify', thread_id: 't1', add_label_ids: ['INBOX'], remove_label_ids: [] },
      recordPayload: { ...payload },
    };
  };
  deps.recordAction = async (row) => {
    recordedAction = { action_type: row.action_type, payload: row.payload };
  };
  deps.incrementBudget = async () => { log.push('budget'); };

  const result = await runAgent({ userId: 'u-1', trigger: 'tick', deps });

  assertEquals(claudeCalls, 2); // 1 tool turn + 1 close turn
  assertEquals(recordedAction?.action_type, 'mail.archive');
  assertEquals(recordedAction?.payload.thread_id, 't1');
  assertEquals(result.processed, 1);
  assertEquals(result.status, 'ok');
});

Deno.test('runAgent: phase-2 path rejects hallucinated thread_id without aborting run', async () => {
  let recordedAction = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't-real', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't-real', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail.archive',
        input: { thread_id: 't-hallucinated' },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async () => {
    recordedAction = true;
    return { reversible: false, reverseToken: null, recordPayload: {} };
  };

  const result = await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(recordedAction, false);
  assertEquals(result.status, 'ok'); // hallucinated tool skipped, run still ok
});

Deno.test('runAgent: phase-2 path short-circuits on budget exceeded', async () => {
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.checkBudget = async () => ({ exceeded: true });

  const result = await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(result.status, 'budget_exceeded');
  assertEquals(result.processed, 0);
});
