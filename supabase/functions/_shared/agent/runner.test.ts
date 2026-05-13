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
        mode: 'executed' as const,
        reversible: false,
        reverseToken: null,
        recordPayload: {},
      }),
      recordAction: async () => {},
      incrementBudget: async () => {},
      // Phase 3 additions
      loadUserPolicy: async () => [],
      loadUserPresence: async () => null,
      writeProposedAction: async () => 'p-stub',
      dispatchProposalPush: async () => {},
      // Phase 3.1 safety deps — defaults err on the safe side: NOT idle,
      // recipient NOT trusted, NO prior failure. Tests that exercise the
      // send_reply auto path override these explicitly.
      isUserIdle: async () => false,
      recipientAllowlistCheck: async () => false,
      priorFailedSendIdem: async () => false,
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
          name: 'mail_archive',
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
      mode: 'executed' as const,
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
        name: 'mail_archive',
        input: { thread_id: 't-hallucinated' },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async () => {
    recordedAction = true;
    return { mode: 'executed' as const, reversible: false, reverseToken: null, recordPayload: {} };
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

Deno.test('runAgent: propose path writes proposed_action and dispatches push when idle', async () => {
  // deno-lint-ignore no-explicit-any
  let proposedRow: Record<string, unknown> | null = null as any;
  let pushDispatched = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.send_reply', mode: 'propose' },
  ];
  deps.loadUserPresence = async () => null;
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail_send_reply',
        input: {
          provider: 'google',
          thread_id: 't1',
          draft_id: 'draft-1',
          draft_hash: 'sha1-abc',
          preview_text: 'Tak.',
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async (_action, payload) => ({
    mode: 'propose' as const,
    reversible: false,
    reverseToken: null,
    recordPayload: { ...payload },
  });
  deps.writeProposedAction = async (row) => {
    proposedRow = row;
    return 'p-1';
  };
  deps.dispatchProposalPush = async () => {
    pushDispatched = true;
  };

  const result = await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(result.status, 'ok');
  assertEquals(proposedRow?.action_type, 'mail.send_reply');
  assertEquals(pushDispatched, true);
});

Deno.test('runAgent: propose path skips push when user is foreground (<60s idle)', async () => {
  let pushDispatched = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [];
  deps.loadUserPresence = async () => new Date();
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail_send_reply',
        input: {
          provider: 'google',
          thread_id: 't1',
          draft_id: 'draft-1',
          draft_hash: 'sha1-abc',
          preview_text: 'Tak.',
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async (_action, payload) => ({
    mode: 'propose' as const,
    reversible: false,
    reverseToken: null,
    recordPayload: { ...payload },
  });
  deps.writeProposedAction = async () => 'p-1';
  deps.dispatchProposalPush = async () => { pushDispatched = true; };

  await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(pushDispatched, false);
});

Deno.test('runAgent: mail.send_reply executes when policy=auto and all rails pass', async () => {
  let executedAction: { action_type: string; payload: Record<string, unknown> } | null = null as
    | { action_type: string; payload: Record<string, unknown> }
    | null;
  let proposed = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.send_reply', mode: 'auto' },
  ];
  // All rails clear:
  deps.isUserIdle = async () => true;
  deps.recipientAllowlistCheck = async () => true;
  deps.priorFailedSendIdem = async () => false;
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail_send_reply',
        input: {
          provider: 'google',
          thread_id: 't1',
          draft_id: 'draft-1',
          draft_hash: 'sha1-abc',
          preview_text: 'Tak.',
          to: 'mor@example.dk',
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  // Mimic real dispatcher: when policy=auto + safety provided + all rails
  // pass, return mode=executed. Verify the runner actually forwarded both.
  let receivedOpts: { policy?: string; safetyDefined?: boolean } | null = null as
    | { policy?: string; safetyDefined?: boolean }
    | null;
  deps.executeTool = async (_action, payload, opts) => {
    receivedOpts = {
      policy: opts?.policy,
      safetyDefined: Boolean(opts?.safety),
    };
    const allRailsClear =
      opts?.safety?.userIsIdle === true &&
      (await opts.safety.hasRecipientHistory('mor@example.dk')) &&
      !(await opts.safety.hasPriorFailedIdem('t1::sha1-abc'));
    return {
      mode: allRailsClear ? 'executed' : 'propose',
      reversible: false,
      reverseToken: null,
      recordPayload: { ...payload },
    };
  };
  deps.recordAction = async (row) => {
    executedAction = { action_type: row.action_type, payload: row.payload };
  };
  deps.writeProposedAction = async () => { proposed = true; return 'p-stub'; };

  const result = await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(result.status, 'ok');
  assertEquals(executedAction?.action_type, 'mail.send_reply');
  assertEquals(proposed, false);
  assertEquals(receivedOpts?.policy, 'auto');
  assertEquals(receivedOpts?.safetyDefined, true);
});

Deno.test('runAgent: mail.send_reply proposes when recipient not in allowlist', async () => {
  let executed = false;
  let proposedRow: Record<string, unknown> | null = null as Record<string, unknown> | null;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.send_reply', mode: 'auto' },
  ];
  deps.isUserIdle = async () => true;
  deps.recipientAllowlistCheck = async () => false; // stranger
  deps.priorFailedSendIdem = async () => false;
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail_send_reply',
        input: {
          provider: 'google',
          thread_id: 't1',
          draft_id: 'draft-1',
          draft_hash: 'sha1-abc',
          preview_text: 'Tak.',
          to: 'stranger@example.com',
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async (_action, payload, opts) => {
    const allRailsClear =
      opts?.safety?.userIsIdle === true &&
      (await opts.safety.hasRecipientHistory('stranger@example.com')) &&
      !(await opts.safety.hasPriorFailedIdem('t1::sha1-abc'));
    return {
      mode: allRailsClear ? 'executed' : 'propose',
      reversible: false,
      reverseToken: null,
      recordPayload: { ...payload },
    };
  };
  deps.recordAction = async () => { executed = true; };
  deps.writeProposedAction = async (row) => { proposedRow = row; return 'p-1'; };

  await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(executed, false);
  assertEquals(proposedRow?.action_type, 'mail.send_reply');
});

Deno.test('runAgent: mail.send_reply proposes when user not idle', async () => {
  let executed = false;
  let proposedRow: Record<string, unknown> | null = null as Record<string, unknown> | null;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.send_reply', mode: 'auto' },
  ];
  deps.isUserIdle = async () => false; // user is foreground
  deps.recipientAllowlistCheck = async () => true;
  deps.priorFailedSendIdem = async () => false;
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail_send_reply',
        input: {
          provider: 'google',
          thread_id: 't1',
          draft_id: 'draft-1',
          draft_hash: 'sha1-abc',
          preview_text: 'Tak.',
          to: 'mor@example.dk',
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async (_action, payload, opts) => {
    const allRailsClear =
      opts?.safety?.userIsIdle === true &&
      (await opts.safety.hasRecipientHistory('mor@example.dk')) &&
      !(await opts.safety.hasPriorFailedIdem('t1::sha1-abc'));
    return {
      mode: allRailsClear ? 'executed' : 'propose',
      reversible: false,
      reverseToken: null,
      recordPayload: { ...payload },
    };
  };
  deps.recordAction = async () => { executed = true; };
  deps.writeProposedAction = async (row) => { proposedRow = row; return 'p-1'; };

  await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(executed, false);
  assertEquals(proposedRow?.action_type, 'mail.send_reply');
});

Deno.test('runAgent: mail.send_reply skips safety lookups when policy=propose', async () => {
  let idleCalls = 0;
  let allowlistCalls = 0;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  // policy=propose explicitly — falls through default; safety should be
  // skipped entirely to avoid a wasted presence read per tool call.
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.send_reply', mode: 'propose' },
  ];
  deps.isUserIdle = async () => { idleCalls += 1; return true; };
  deps.recipientAllowlistCheck = async () => { allowlistCalls += 1; return true; };
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail_send_reply',
        input: {
          provider: 'google',
          thread_id: 't1',
          draft_id: 'draft-1',
          draft_hash: 'sha1-abc',
          preview_text: 'Tak.',
          to: 'mor@example.dk',
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async (_action, payload, opts) => ({
    mode: opts?.safety ? 'executed' : 'propose',
    reversible: false,
    reverseToken: null,
    recordPayload: { ...payload },
  });
  deps.writeProposedAction = async () => 'p-1';

  await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(idleCalls, 0);
  assertEquals(allowlistCalls, 0);
});

Deno.test('runAgent: deferred-execute — policy=propose on default-auto action writes proposal instead of executing', async () => {
  let executeToolCalled = false;
  let proposedRow: Record<string, unknown> | null = null as Record<string, unknown> | null;
  let pushDispatched = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Newsletter', snippet: '' },
  ];
  // User flipped mail.archive (default=auto) to propose.
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.archive', mode: 'propose' },
  ];
  // No recent presence → push fires.
  deps.loadUserPresence = async () => null;
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail_archive',
        input: { provider: 'google', thread_id: 't1' },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  // Tripwire — must NOT be called when policy=propose on a default-auto action.
  deps.executeTool = async () => {
    executeToolCalled = true;
    throw new Error('executeTool should not be invoked on deferred-execute');
  };
  deps.writeProposedAction = async (row) => {
    proposedRow = row;
    return 'p-deferred-1';
  };
  deps.dispatchProposalPush = async () => { pushDispatched = true; };

  const result = await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(result.status, 'ok');
  assertEquals(executeToolCalled, false);
  assertEquals(proposedRow?.action_type, 'mail.archive');
  const payload = proposedRow?.payload as Record<string, unknown>;
  assertEquals(payload?.thread_id, 't1');
  assertEquals(payload?.provider, 'google');
  assertEquals(payload?.deferred_execute, true);
  assertEquals(typeof payload?.idem_key, 'string');
  assertEquals(pushDispatched, true);
});

Deno.test('runAgent: policy off causes the tool to be rejected without execution', async () => {
  let executed = false;
  let proposed = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.archive', mode: 'off' },
  ];
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail_archive',
        input: { provider: 'google', thread_id: 't1' },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async () => {
    executed = true;
    return { mode: 'executed' as const, reversible: false, reverseToken: null, recordPayload: {} };
  };
  deps.writeProposedAction = async () => { proposed = true; return 'p'; };

  await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(executed, false);
  assertEquals(proposed, false);
});
