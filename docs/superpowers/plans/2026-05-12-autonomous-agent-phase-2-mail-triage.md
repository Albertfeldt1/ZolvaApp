# Autonomous Agent — Phase 2 (Mail Triage, Auto) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase-1 no-op runner with a real Claude-driven mail-triage loop. When `poll-mail` finds new Gmail messages it emits `mail.new` agent_events; `agent-tick` (cron-driven) drains them per user, calls Claude with a four-tool catalog (`mail.label`, `mail.archive`, `mail.summarize`, `mail.flag_important`), executes the chosen actions against Gmail, and writes each one to `agent_actions` with a reverse-token. The Today tab swaps its empty state for a feed of recently-done actions with one-tap Undo.

**Architecture:** Producer (`poll-mail`) writes events. Consumer (`agent-tick` via pg_cron, every 1 min) claims a per-user batch with the advisory-locked RPC, opens an `agent_runs` row, loads message metadata for each event, calls Claude once with a tool catalog, executes any `tool_use` blocks server-side against the Gmail API (with hallucination-guarded thread IDs), writes each execution to `agent_actions` with `reversible=true` + `reverse_token`, marks events processed, finishes the run. A separate `agent-undo` edge function reverses an action when the user taps Undo. Outlook + iCloud mail triage are deferred to a Phase 2.1 follow-up.

**Tech Stack:** Supabase Postgres + RLS, Deno edge functions, raw `fetch` to Gmail v1 + Anthropic Messages API (model `claude-haiku-4-5-20251001`), Expo / React Native + Supabase realtime, Jest (client), Deno test (edge functions).

**Spec:** `docs/superpowers/specs/2026-05-11-autonomous-background-actions-design.md` (esp. §4.1 events, §5.1 action catalog, §8.1 idem keys, §8.4 safety rails, §9.4 hallucination guard, §10 phase 2 row).

**Phase 1 foundations being reused:** tables `agent_events`, `agent_runs`, `agent_actions`, `user_agent_budget`; RPCs `agent_claim_events`, `agent_budget_increment`; modules `_shared/agent/{types,policy,budget,runner}.ts`; cron-secret + JWT entrypoint in `agent-tick/index.ts`.

---

## Scope (in vs. out)

**In Phase 2:**
- `poll-mail` emits `mail.new` events for **google** watchers only.
- Real Claude runner replacing the Phase-1 no-op.
- Four Gmail tools: `mail.label`, `mail.archive`, `mail.summarize`, `mail.flag_important`.
- Token-budget enforcement (uses Phase-1 `loadTodayBudget` / `incrementBudget`).
- Hallucination guard (thread IDs Claude references must be in the claimed batch).
- `agent-undo` edge function.
- Today-screen feed of executed actions with Undo.
- `agent_enabled` gating in the cron path (Phase-1 carry-over #1).
- `schedule-agent-tick.sql.template` cron entry.

**Out (deferred to 2.1+):**
- Outlook (Microsoft Graph) mail triage tools — emit events only when we ship the corresponding tool implementations.
- iCloud mail triage (no write API).
- `proposed_actions` flow + push notifications (Phase 3).
- `mail.draft_reply` / `mail.send_reply` (Phase 3).
- Calendar tools, reflection sweeps, memory follow-ups (Phase 4).
- `agent-reflect` cron (Phase 4).

---

## File structure

### Created
- `supabase/migrations/20260512180000_agent_phase2.sql` — `agent_revert_action` RPC + helper view `v_users_with_pending_agent_events` (filters by `agent_enabled`).
- `supabase/schedule-agent-tick.sql.template` — pg_cron entry calling `agent-tick` every minute (manual-apply).
- `supabase/functions/_shared/agent/idem.ts` — derive idempotency key per `ActionType` per spec §8.1.
- `supabase/functions/_shared/agent/idem.test.ts`
- `supabase/functions/_shared/agent/verify.ts` — hallucination guard: thread IDs must belong to a claimed event.
- `supabase/functions/_shared/agent/verify.test.ts`
- `supabase/functions/_shared/agent/tools/gmail.ts` — Gmail tool implementations + reverse helpers.
- `supabase/functions/_shared/agent/tools/gmail.test.ts`
- `supabase/functions/_shared/agent/tools/dispatch.ts` — `executeTool(actionType, payload, ctx)` → `{ reverseToken | null, recordPayload }`.
- `supabase/functions/_shared/agent/tools/dispatch.test.ts`
- `supabase/functions/_shared/agent/claude.ts` — Anthropic Messages API caller mirroring chat-run's pattern.
- `supabase/functions/_shared/agent/claude.test.ts`
- `supabase/functions/_shared/agent/prompt.ts` — system prompt + user message builder for a mail-triage turn.
- `supabase/functions/_shared/agent/prompt.test.ts`
- `supabase/functions/agent-undo/index.ts` — POST `{ action_id }`, JWT-authenticated, reverses via provider API.
- `supabase/functions/agent-undo/deno.json`
- `src/lib/agent-feed.ts` — `useAgentActions(userId)` hook + `revertAgentAction(actionId)` client helper.
- `src/lib/__tests__/agent-feed.test.ts`
- `src/components/AgentActionCard.tsx` — single ✓ DONE row with Undo button.
- `src/components/TodayAgentFeed.tsx` — list of recent `agent_actions`, falls back to `<AgentEmptyState />` when empty.

### Modified
- `supabase/functions/_shared/agent/runner.ts` — extend `RunnerDeps`, replace no-op body with claim → load context → Claude → tool loop → record actions → finish.
- `supabase/functions/_shared/agent/runner.test.ts` — add tests for the Claude/tool path with stubbed deps; keep the existing no-op orchestration tests (they cover the empty-claim short-circuit).
- `supabase/functions/agent-tick/index.ts` — gate `userIdsWithPendingEvents` on `agent_enabled = true` (carry-over #1); inject the new deps (`loadGmailAccessToken`, `loadThreadMetadata`, `callClaude`, `executeTool`, budget helpers); record idem key + reverse_token when writing actions.
- `supabase/functions/poll-mail/index.ts` — emit a `mail.new` event into `agent_events` per new message for google watchers, after the watermark update.
- `src/screens/TodayScreen.tsx` — replace direct `<AgentEmptyState />` render with `<TodayAgentFeed />`.

---

## Task 1: Migration — undo RPC + agent_enabled-aware pending-users view

**Files:**
- Create: `supabase/migrations/20260512180000_agent_phase2.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260512180000_agent_phase2.sql
--
-- Phase 2 (mail triage) additions to the autonomous-agent foundations:
--   1. agent_revert_action RPC — atomic undo guard so two taps can't
--      double-revert the same row.
--   2. v_users_with_pending_agent_events view — drives the cron-driven
--      agent-tick batch; filters out users who have flipped agent_enabled
--      off so we never spin a Claude turn for an opted-out user. This
--      addresses Phase 1 carry-over #1.
--
-- Phase 2 does NOT add any new tables: agent_actions / agent_runs /
-- agent_events from migration 20260511180000 are the only writes.

-- Atomic undo: claim the row by stamping reversed_at and return whether
-- this caller was the one to claim it. Subsequent taps see reversed=false.
create or replace function public.agent_revert_action(
  p_action_id uuid,
  p_user_id   uuid
) returns table (claimed boolean, action_type text, reverse_token jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.agent_actions a
     set reversed_at = now()
   where a.id = p_action_id
     and a.user_id = p_user_id
     and a.reversible = true
     and a.reversed_at is null
  returning true, a.action_type, a.reverse_token;
end;
$$;

revoke all on function public.agent_revert_action(uuid, uuid) from public;
grant execute on function public.agent_revert_action(uuid, uuid) to service_role;

-- Eligible-users view: any user with at least one unprocessed event AND
-- agent_enabled = true. security_invoker so callers see only their own
-- row when reading via RLS; service-role bypasses RLS as before.
create or replace view public.v_users_with_pending_agent_events
  with (security_invoker = on)
  as
  select distinct e.user_id
  from public.agent_events e
  join public.user_profiles p on p.user_id = e.user_id
  where e.processed_at is null
    and p.agent_enabled = true;
```

- [ ] **Step 2: Apply locally**

Run:
```bash
supabase db reset --local
psql "$LOCAL_DB_URL" -c "\df public.agent_revert_action"
psql "$LOCAL_DB_URL" -c "select count(*) from v_users_with_pending_agent_events;"
```
Expected: function listed; view query returns 0 with no errors.

- [ ] **Step 3: Verify the gating works**

```bash
psql "$LOCAL_DB_URL" <<'SQL'
insert into auth.users (id, email)
  values ('00000000-0000-0000-0000-0000000000aa', 'a@test.local')
  on conflict do nothing;
insert into auth.users (id, email)
  values ('00000000-0000-0000-0000-0000000000bb', 'b@test.local')
  on conflict do nothing;
insert into public.user_profiles (user_id, timezone, agent_enabled)
  values ('00000000-0000-0000-0000-0000000000aa', 'UTC', true)
  on conflict (user_id) do update set agent_enabled = excluded.agent_enabled;
insert into public.user_profiles (user_id, timezone, agent_enabled)
  values ('00000000-0000-0000-0000-0000000000bb', 'UTC', false)
  on conflict (user_id) do update set agent_enabled = excluded.agent_enabled;
insert into public.agent_events (user_id, kind, payload)
  values ('00000000-0000-0000-0000-0000000000aa', 'mail.new', '{"x":1}'::jsonb),
         ('00000000-0000-0000-0000-0000000000bb', 'mail.new', '{"y":1}'::jsonb);
select user_id from v_users_with_pending_agent_events order by user_id;
SQL
```
Expected: exactly one row, the `aa` user. The `bb` user is hidden because `agent_enabled=false`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260512180000_agent_phase2.sql
git commit -m "feat(agent): phase 2 migration — undo RPC + agent_enabled gating view"
```

---

## Task 2: Cron template — `agent-tick` every minute

**Files:**
- Create: `supabase/schedule-agent-tick.sql.template`

Per repo convention (`project_cron_template_apply.md`), `.sql.template` files are **manually applied** via the Supabase Dashboard SQL editor; we never auto-apply them.

- [ ] **Step 1: Write the template**

```sql
-- supabase/schedule-agent-tick.sql.template
--
-- Paste this whole file into the Supabase Dashboard SQL editor.
-- Replace PASTE_SERVICE_ROLE_KEY with the raw service_role key from
--   Project Settings -> API, and PASTE_CRON_SHARED_SECRET with the value
--   you also set as `CRON_SHARED_SECRET` in Edge Function secrets.
-- Do NOT keep the angle brackets.

select cron.schedule(
  'agent-tick-every-min',
  '* * * * *',
  $cmd$select net.http_post(
    url:='https://sjkhfkatmeqtsrysixop.functions.supabase.co/agent-tick',
    headers:=jsonb_build_object(
      'Authorization','Bearer PASTE_SERVICE_ROLE_KEY',
      'Content-Type','application/json',
      'x-cron-secret','PASTE_CRON_SHARED_SECRET'
    )
  ) as request_id;$cmd$
);
```

- [ ] **Step 2: Commit the template**

```bash
git add supabase/schedule-agent-tick.sql.template
git commit -m "feat(agent): cron template for agent-tick (manual apply)"
```

Manual apply is deferred to the deploy task (Task 20). Do not execute now.

---

## Task 3: `agent-tick` gating on `agent_enabled` (Phase 1 carry-over #1)

**Files:**
- Modify: `supabase/functions/agent-tick/index.ts`

- [ ] **Step 1: Add a Deno test that fails because the gate is missing**

Append to `supabase/functions/agent-tick/index.test.ts` (create the file if absent):

```ts
// supabase/functions/agent-tick/index.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { selectEligibleUserIds } from './index.ts';

Deno.test('selectEligibleUserIds: filters via v_users_with_pending_agent_events', async () => {
  const calls: string[] = [];
  const fakeClient = {
    from(view: string) {
      calls.push(view);
      assertEquals(view, 'v_users_with_pending_agent_events');
      return {
        select(_cols: string) {
          return Promise.resolve({
            data: [
              { user_id: 'u-1' },
              { user_id: 'u-2' },
              { user_id: 'u-1' },
            ],
            error: null,
          });
        },
      };
    },
  };
  const ids = await selectEligibleUserIds(fakeClient as never);
  assertEquals(ids.sort(), ['u-1', 'u-2']);
  assertEquals(calls, ['v_users_with_pending_agent_events']);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/agent-tick/index.test.ts`
Expected: FAIL — `selectEligibleUserIds` not exported.

- [ ] **Step 3: Rename and re-implement the helper in `index.ts`**

In `supabase/functions/agent-tick/index.ts`, **replace** the existing `userIdsWithPendingEvents` function with the exported gating-aware version:

```ts
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
```

Update the `serve` handler call site:
```ts
if (isCron) {
  userIds = await selectEligibleUserIds(serviceClient);
} else {
  // ... unchanged
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/agent-tick/index.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/agent-tick/index.ts supabase/functions/agent-tick/index.test.ts
git commit -m "feat(agent): gate cron-path users on agent_enabled via v_users_with_pending_agent_events"
```

---

## Task 4: `poll-mail` emits `mail.new` agent_events (google watchers)

**Files:**
- Modify: `supabase/functions/poll-mail/index.ts`

- [ ] **Step 1: Write the failing Deno test**

Create `supabase/functions/poll-mail/emit.test.ts`:

```ts
// supabase/functions/poll-mail/emit.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildMailNewEventRows } from './emit.ts';

Deno.test('buildMailNewEventRows: one row per gmail message with idem_key', () => {
  const rows = buildMailNewEventRows({
    userId: 'u-1',
    provider: 'google',
    messages: [
      { messageId: 'm1', threadId: 't1', subject: 'Hi', from: 'a@x' },
      { messageId: 'm2', threadId: 't2', subject: 'Hello', from: 'b@x' },
    ],
  });
  assertEquals(rows.length, 2);
  assertEquals(rows[0].kind, 'mail.new');
  assertEquals(rows[0].user_id, 'u-1');
  assertEquals(rows[0].payload, {
    provider: 'google',
    message_id: 'm1',
    thread_id: 't1',
    from: 'a@x',
    subject: 'Hi',
    idem_key: 'google:m1',
  });
});

Deno.test('buildMailNewEventRows: returns empty for microsoft (phase 2 scope)', () => {
  const rows = buildMailNewEventRows({
    userId: 'u-1',
    provider: 'microsoft',
    messages: [
      { messageId: 'm1', threadId: 't1', subject: 'Hi', from: 'a@x' },
    ],
  });
  assertEquals(rows, []);
});

Deno.test('buildMailNewEventRows: handles missing threadId', () => {
  const rows = buildMailNewEventRows({
    userId: 'u-1',
    provider: 'google',
    messages: [
      { messageId: 'm1', threadId: undefined, subject: 'Hi', from: 'a@x' },
    ],
  });
  assertEquals(rows[0].payload.thread_id, null);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/poll-mail/emit.test.ts`
Expected: FAIL — module `./emit.ts` not found.

- [ ] **Step 3: Implement the pure builder**

Create `supabase/functions/poll-mail/emit.ts`:

```ts
// supabase/functions/poll-mail/emit.ts
//
// Pure helpers for emitting `mail.new` agent_events from poll-mail.
// The DB insert lives in index.ts; this file is intentionally side-effect-free
// so it can be unit-tested without a Supabase client.

export interface PollMailMessage {
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
}

export interface BuildMailNewEventsInput {
  userId: string;
  provider: 'google' | 'microsoft';
  messages: PollMailMessage[];
}

export interface MailNewEventRow {
  user_id: string;
  kind: 'mail.new';
  payload: {
    provider: 'google';
    message_id: string;
    thread_id: string | null;
    from: string;
    subject: string;
    idem_key: string;
  };
}

// Phase 2 only emits events for google watchers. Microsoft + iCloud
// follow in 2.1 when the matching tool implementations land.
export function buildMailNewEventRows(
  input: BuildMailNewEventsInput,
): MailNewEventRow[] {
  if (input.provider !== 'google') return [];
  return input.messages.map((m) => ({
    user_id: input.userId,
    kind: 'mail.new',
    payload: {
      provider: 'google',
      message_id: m.messageId,
      thread_id: m.threadId ?? null,
      from: m.from,
      subject: m.subject,
      idem_key: `google:${m.messageId}`,
    },
  }));
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/poll-mail/emit.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Wire it into `index.ts`**

In `supabase/functions/poll-mail/index.ts`:

1. Add the import near the top with the other relative imports (currently `import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';`):

```ts
import { buildMailNewEventRows } from './emit.ts';
```

2. Inside `processWatcher`, **after** the watermark update (currently line 141, immediately after `.eq('user_id', watcher.user_id).eq('provider', watcher.provider);`) and **before** the `if (messages.length === 0) return;` line, insert:

```ts
const eventRows = buildMailNewEventRows({
  userId: watcher.user_id,
  provider: watcher.provider,
  messages,
});
if (eventRows.length > 0) {
  // Dedupe on (user_id, kind, idem_key) is enforced by the partial unique
  // index on agent_actions, NOT agent_events — agent_events itself is an
  // append log and intentionally has no dedup; we rely on the runner to
  // skip duplicate idem_keys during executeTool. So a bulk insert is fine.
  const { error: insertErr } = await client.from('agent_events').insert(eventRows);
  if (insertErr) {
    console.warn('[poll-mail] agent_events insert failed:', insertErr.message);
  }
}
```

- [ ] **Step 6: Type-check and smoke-test the function**

```bash
deno check supabase/functions/poll-mail/index.ts
supabase functions serve poll-mail --env-file ./supabase/.env.local
# In another shell, with a seeded watcher row + a fake history insert:
curl -sX POST http://localhost:54321/functions/v1/poll-mail \
  -H "x-cron-secret: test-secret" | jq
psql "$LOCAL_DB_URL" -c "select kind, payload->>'message_id' as msg from agent_events order by id desc limit 5;"
```
Expected: type-check passes; if your local watcher has a stub history one or more `mail.new` rows are returned.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/poll-mail/index.ts supabase/functions/poll-mail/emit.ts supabase/functions/poll-mail/emit.test.ts
git commit -m "feat(agent): poll-mail emits mail.new agent_events for google watchers"
```

---

## Task 5: Idempotency-key derivation module

**Files:**
- Create: `supabase/functions/_shared/agent/idem.ts`, `supabase/functions/_shared/agent/idem.test.ts`

Spec §8.1 defines per-action-type keys. Phase 2 only needs the four mail-triage variants but we wire the dispatch by `ActionType` so adding the rest in later phases is one-line.

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/agent/idem.test.ts
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deriveIdemKey } from './idem.ts';

Deno.test('mail.label idem key includes thread_id, label, op', () => {
  assertEquals(
    deriveIdemKey('mail.label', { thread_id: 't1', label: 'Receipts', op: 'add' }),
    'mail.label:t1:Receipts:add',
  );
});

Deno.test('mail.archive idem key uses thread_id', () => {
  assertEquals(
    deriveIdemKey('mail.archive', { thread_id: 't1' }),
    'mail.archive:t1',
  );
});

Deno.test('mail.summarize idem key uses thread_id', () => {
  assertEquals(
    deriveIdemKey('mail.summarize', { thread_id: 't1' }),
    'mail.summarize:t1',
  );
});

Deno.test('mail.flag_important idem key uses thread_id', () => {
  assertEquals(
    deriveIdemKey('mail.flag_important', { thread_id: 't1' }),
    'mail.flag_important:t1',
  );
});

Deno.test('deriveIdemKey throws on missing required field', () => {
  assertThrows(() => deriveIdemKey('mail.archive', {} as never), Error, 'thread_id');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/idem.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/agent/idem.ts
import type { ActionType } from './types.ts';

export type IdemPayload = Record<string, unknown>;

function req(payload: IdemPayload, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`idem payload missing required field ${key}`);
  }
  return v;
}

export function deriveIdemKey(action: ActionType, payload: IdemPayload): string {
  switch (action) {
    case 'mail.label':
      return `mail.label:${req(payload, 'thread_id')}:${req(payload, 'label')}:${req(payload, 'op')}`;
    case 'mail.archive':
      return `mail.archive:${req(payload, 'thread_id')}`;
    case 'mail.summarize':
      return `mail.summarize:${req(payload, 'thread_id')}`;
    case 'mail.flag_important':
      return `mail.flag_important:${req(payload, 'thread_id')}`;
    default:
      // Phase 3+ action types reach this branch — caller is responsible
      // for not invoking it on unsupported types in Phase 2.
      throw new Error(`deriveIdemKey: unsupported action type ${action}`);
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/idem.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/idem.ts supabase/functions/_shared/agent/idem.test.ts
git commit -m "feat(agent): idempotency-key derivation for phase 2 mail actions"
```

---

## Task 6: Hallucination-guard / verifier module

**Files:**
- Create: `supabase/functions/_shared/agent/verify.ts`, `supabase/functions/_shared/agent/verify.test.ts`

Spec §9.4: any thread/message ID Claude references must round-trip-verify against the source. For Phase 2 the cheap check is "thread_id is in the claimed event batch". The expensive Gmail-side check (does this thread still exist?) is implicit because the tool call to Gmail would 404 anyway.

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/agent/verify.test.ts
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildThreadAllowlist, verifyThreadId } from './verify.ts';

const sampleEvents = [
  { id: 1, kind: 'mail.new' as const, payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  { id: 2, kind: 'mail.new' as const, payload: { thread_id: 't2', message_id: 'm2', provider: 'google' } },
];

Deno.test('buildThreadAllowlist: pulls thread_ids from mail.new events', () => {
  assertEquals(buildThreadAllowlist(sampleEvents), new Set(['t1', 't2']));
});

Deno.test('verifyThreadId: passes when thread is in allowlist', () => {
  const allow = buildThreadAllowlist(sampleEvents);
  verifyThreadId('t1', allow); // no throw
});

Deno.test('verifyThreadId: throws when thread is hallucinated', () => {
  const allow = buildThreadAllowlist(sampleEvents);
  assertThrows(() => verifyThreadId('t-fake', allow), Error, 'unknown thread');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/verify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/agent/verify.ts
import type { ClaimedEvent } from './runner.ts';

export function buildThreadAllowlist(events: ClaimedEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'mail.new') continue;
    const tid = e.payload.thread_id;
    if (typeof tid === 'string' && tid) out.add(tid);
  }
  return out;
}

export function verifyThreadId(threadId: string, allow: Set<string>): void {
  if (!allow.has(threadId)) {
    throw new Error(`hallucination-guard: unknown thread ${threadId}`);
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/verify.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/verify.ts supabase/functions/_shared/agent/verify.test.ts
git commit -m "feat(agent): hallucination guard via claimed-event thread allowlist"
```

---

## Task 7: Gmail tool implementations

**Files:**
- Create: `supabase/functions/_shared/agent/tools/gmail.ts`, `supabase/functions/_shared/agent/tools/gmail.test.ts`

The four Phase-2 tools translate to Gmail's `users.threads.modify` (label add/remove) and a special label `Zolva flaggede` for `mail.flag_important`. `mail.summarize` doesn't touch Gmail — it produces a text summary that lives only in `agent_actions.payload.summary` and the Today feed.

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/agent/tools/gmail.test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  gmailModifyThread,
  resolveLabelId,
  ZOLVA_FLAGGED_LABEL,
  type GmailFetch,
} from './gmail.ts';

function makeFetch(
  responses: Array<{ url: string; status: number; body: unknown }>,
): { fetch: GmailFetch; calls: Array<{ url: string; method: string; body: string | null }> } {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const r = responses[i++];
      if (r.url !== url) {
        throw new Error(`unexpected url at step ${i}: got ${url}, want ${r.url}`);
      }
      return new Response(JSON.stringify(r.body), { status: r.status });
    },
  };
}

Deno.test('gmailModifyThread: add Receipts label, reverseToken removes it', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify',
      status: 200,
      body: { id: 't1' },
    },
  ]);
  const result = await gmailModifyThread({
    fetch,
    accessToken: 'tok',
    threadId: 't1',
    addLabelIds: ['L_RCPT'],
    removeLabelIds: [],
  });
  assertEquals(result.reverseToken, {
    kind: 'gmail.modify',
    thread_id: 't1',
    add_label_ids: [],
    remove_label_ids: ['L_RCPT'],
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'POST');
  assertEquals(JSON.parse(calls[0].body!), {
    addLabelIds: ['L_RCPT'],
    removeLabelIds: [],
  });
});

Deno.test('gmailModifyThread: archive (remove INBOX) reverses by re-adding', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify',
      status: 200,
      body: { id: 't1' },
    },
  ]);
  const result = await gmailModifyThread({
    fetch,
    accessToken: 'tok',
    threadId: 't1',
    addLabelIds: [],
    removeLabelIds: ['INBOX'],
  });
  assertEquals(result.reverseToken, {
    kind: 'gmail.modify',
    thread_id: 't1',
    add_label_ids: ['INBOX'],
    remove_label_ids: [],
  });
});

Deno.test('gmailModifyThread: surfaces Gmail 4xx as a typed error', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify',
      status: 403,
      body: { error: { message: 'insufficient permissions' } },
    },
  ]);
  await assertRejects(
    () =>
      gmailModifyThread({
        fetch,
        accessToken: 'tok',
        threadId: 't1',
        addLabelIds: ['L'],
        removeLabelIds: [],
      }),
    Error,
    'gmail threads.modify 403',
  );
});

Deno.test('resolveLabelId: finds existing label by case-insensitive name', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      status: 200,
      body: {
        labels: [
          { id: 'L_RCPT', name: 'Receipts' },
          { id: 'L_ZOLVA', name: 'Zolva flaggede' },
        ],
      },
    },
  ]);
  const id = await resolveLabelId({ fetch, accessToken: 'tok', name: 'receipts' });
  assertEquals(id, 'L_RCPT');
});

Deno.test('resolveLabelId: creates the Zolva-flagged label when missing', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      status: 200,
      body: { labels: [] },
    },
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      status: 200,
      body: { id: 'L_NEW', name: ZOLVA_FLAGGED_LABEL },
    },
  ]);
  const id = await resolveLabelId({ fetch, accessToken: 'tok', name: ZOLVA_FLAGGED_LABEL });
  assertEquals(id, 'L_NEW');
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, 'POST');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/tools/gmail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/agent/tools/gmail.ts
//
// Gmail v1 write operations used by phase-2 mail-triage tools.
// The `fetch` parameter is injectable so unit tests can stub the network
// without monkey-patching globalThis.

export type GmailFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface ModifyInput {
  fetch: GmailFetch;
  accessToken: string;
  threadId: string;
  addLabelIds: string[];
  removeLabelIds: string[];
}

export interface GmailModifyReverseToken {
  kind: 'gmail.modify';
  thread_id: string;
  add_label_ids: string[];
  remove_label_ids: string[];
}

export interface GmailModifyResult {
  reverseToken: GmailModifyReverseToken;
}

export const ZOLVA_FLAGGED_LABEL = 'Zolva flaggede';

export async function gmailModifyThread(input: ModifyInput): Promise<GmailModifyResult> {
  const res = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${input.threadId}/modify`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        addLabelIds: input.addLabelIds,
        removeLabelIds: input.removeLabelIds,
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail threads.modify ${res.status}: ${detail.slice(0, 200)}`);
  }
  return {
    reverseToken: {
      kind: 'gmail.modify',
      thread_id: input.threadId,
      // Reverse: what we added we remove, what we removed we add.
      add_label_ids: [...input.removeLabelIds],
      remove_label_ids: [...input.addLabelIds],
    },
  };
}

export interface ResolveLabelInput {
  fetch: GmailFetch;
  accessToken: string;
  name: string;
}

export async function resolveLabelId(input: ResolveLabelInput): Promise<string> {
  const listRes = await input.fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!listRes.ok) throw new Error(`gmail labels.list ${listRes.status}`);
  const list = (await listRes.json()) as { labels?: Array<{ id: string; name: string }> };
  const wantLower = input.name.toLowerCase();
  const hit = (list.labels ?? []).find((l) => l.name.toLowerCase() === wantLower);
  if (hit) return hit.id;

  const createRes = await input.fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    },
  );
  if (!createRes.ok) throw new Error(`gmail labels.create ${createRes.status}`);
  const created = (await createRes.json()) as { id: string };
  return created.id;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/tools/gmail.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/gmail.ts \
        supabase/functions/_shared/agent/tools/gmail.test.ts
git commit -m "feat(agent): gmail thread.modify + label resolver with reverse tokens"
```

---

## Task 8: Tool dispatcher

**Files:**
- Create: `supabase/functions/_shared/agent/tools/dispatch.ts`, `supabase/functions/_shared/agent/tools/dispatch.test.ts`

The dispatcher converts a `(actionType, payload)` from Claude into a concrete tool call. It returns what the runner needs to write into `agent_actions`.

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/agent/tools/dispatch.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { executeTool, type ExecuteContext } from './dispatch.ts';

function makeCtx(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    accessToken: 'tok',
    fetch: async () => new Response('{}', { status: 200 }),
    resolveLabelId: async (name) => `L_${name.toUpperCase().replace(/\s+/g, '_')}`,
    ...overrides,
  };
}

Deno.test('executeTool: mail.archive removes INBOX label', async () => {
  let captured: { url: string; body: string } | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = { url, body: String(init?.body ?? '') };
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool('mail.archive', { thread_id: 't1' }, ctx);
  assertEquals(captured!.url.endsWith('/threads/t1/modify'), true);
  assertEquals(JSON.parse(captured!.body), {
    addLabelIds: [],
    removeLabelIds: ['INBOX'],
  });
  assertEquals(result.reverseToken?.kind, 'gmail.modify');
  assertEquals(result.recordPayload.thread_id, 't1');
  assertEquals(result.reversible, true);
});

Deno.test('executeTool: mail.label add resolves and applies', async () => {
  let captured: { url: string; body: string } | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = { url, body: String(init?.body ?? '') };
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.label',
    { thread_id: 't1', label: 'Receipts', op: 'add' },
    ctx,
  );
  assertEquals(JSON.parse(captured!.body), {
    addLabelIds: ['L_RECEIPTS'],
    removeLabelIds: [],
  });
  assertEquals(result.recordPayload.label, 'Receipts');
  assertEquals(result.recordPayload.op, 'add');
});

Deno.test('executeTool: mail.flag_important applies Zolva flaggede label', async () => {
  let captured: { url: string; body: string } | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = { url, body: String(init?.body ?? '') };
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.flag_important',
    { thread_id: 't1' },
    ctx,
  );
  assertEquals(JSON.parse(captured!.body), {
    addLabelIds: ['L_ZOLVA_FLAGGEDE'],
    removeLabelIds: [],
  });
  assertEquals(result.recordPayload.thread_id, 't1');
});

Deno.test('executeTool: mail.summarize records summary, no Gmail call, not reversible', async () => {
  let fetchCalls = 0;
  const ctx = makeCtx({
    fetch: async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.summarize',
    { thread_id: 't1', summary: 'Acme renewal — expires 2026-05-30.' },
    ctx,
  );
  assertEquals(fetchCalls, 0);
  assertEquals(result.reversible, false);
  assertEquals(result.reverseToken, null);
  assertEquals(result.recordPayload.summary, 'Acme renewal — expires 2026-05-30.');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/tools/dispatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/agent/tools/dispatch.ts
import type { ActionType } from '../types.ts';
import {
  gmailModifyThread,
  resolveLabelId,
  ZOLVA_FLAGGED_LABEL,
  type GmailFetch,
  type GmailModifyReverseToken,
} from './gmail.ts';

export interface ExecuteContext {
  accessToken: string;
  fetch: GmailFetch;
  // Pluggable so tests don't need to stub the label-list/create calls.
  resolveLabelId: (name: string) => Promise<string>;
}

export type ExecuteReverseToken = GmailModifyReverseToken | null;

export interface ExecuteResult {
  reversible: boolean;
  reverseToken: ExecuteReverseToken;
  // The payload the caller will store on agent_actions. Always includes
  // thread_id; mail.label / mail.flag_important add label, op; mail.summarize
  // adds summary text.
  recordPayload: Record<string, unknown>;
}

export async function executeTool(
  action: ActionType,
  payload: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  switch (action) {
    case 'mail.archive': {
      const threadId = mustString(payload, 'thread_id');
      const { reverseToken } = await gmailModifyThread({
        fetch: ctx.fetch,
        accessToken: ctx.accessToken,
        threadId,
        addLabelIds: [],
        removeLabelIds: ['INBOX'],
      });
      return {
        reversible: true,
        reverseToken,
        recordPayload: { thread_id: threadId },
      };
    }
    case 'mail.label': {
      const threadId = mustString(payload, 'thread_id');
      const label = mustString(payload, 'label');
      const op = mustString(payload, 'op'); // 'add' | 'remove'
      if (op !== 'add' && op !== 'remove') {
        throw new Error(`mail.label op must be add|remove, got ${op}`);
      }
      const labelId = await ctx.resolveLabelId(label);
      const { reverseToken } = await gmailModifyThread({
        fetch: ctx.fetch,
        accessToken: ctx.accessToken,
        threadId,
        addLabelIds: op === 'add' ? [labelId] : [],
        removeLabelIds: op === 'remove' ? [labelId] : [],
      });
      return {
        reversible: true,
        reverseToken,
        recordPayload: { thread_id: threadId, label, op },
      };
    }
    case 'mail.flag_important': {
      const threadId = mustString(payload, 'thread_id');
      const labelId = await ctx.resolveLabelId(ZOLVA_FLAGGED_LABEL);
      const { reverseToken } = await gmailModifyThread({
        fetch: ctx.fetch,
        accessToken: ctx.accessToken,
        threadId,
        addLabelIds: [labelId],
        removeLabelIds: [],
      });
      return {
        reversible: true,
        reverseToken,
        recordPayload: { thread_id: threadId },
      };
    }
    case 'mail.summarize': {
      const threadId = mustString(payload, 'thread_id');
      const summary = mustString(payload, 'summary');
      return {
        reversible: false,
        reverseToken: null,
        recordPayload: { thread_id: threadId, summary },
      };
    }
    default:
      throw new Error(`executeTool: unsupported action type ${action} (phase 2 only handles mail.* triage)`);
  }
}

function mustString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`tool payload missing required string field ${key}`);
  }
  return v;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/tools/dispatch.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/dispatch.ts \
        supabase/functions/_shared/agent/tools/dispatch.test.ts
git commit -m "feat(agent): tool dispatcher for phase 2 mail actions"
```

---

## Task 9: Anthropic Messages API caller for the agent

**Files:**
- Create: `supabase/functions/_shared/agent/claude.ts`, `supabase/functions/_shared/agent/claude.test.ts`

Mirrors the pattern from `chat-run` (raw `fetch` to `/v1/messages`, model `claude-haiku-4-5-20251001`, system as array of cacheable text blocks, tools passed as-is).

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/agent/claude.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { callClaude, type ClaudeFetch } from './claude.ts';

function makeFetch(body: unknown, status = 200): { fetch: ClaudeFetch; last: { body: string } } {
  const last = { body: '' };
  return {
    last,
    fetch: async (_url, init) => {
      last.body = String(init?.body ?? '');
      return new Response(JSON.stringify(body), { status });
    },
  };
}

Deno.test('callClaude: sends system + messages + tools, returns parsed body', async () => {
  const { fetch, last } = makeFetch({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 12, output_tokens: 5 },
    stop_reason: 'end_turn',
  });
  const out = await callClaude({
    fetch,
    apiKey: 'sk-fake',
    system: [{ type: 'text', text: 'You are Zolva.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Triage these mails.' }],
    tools: [{ name: 'mail.archive', input_schema: { type: 'object' } }],
  });
  assertEquals(out.usage.input_tokens, 12);
  assertEquals(out.usage.output_tokens, 5);
  assertEquals(out.stop_reason, 'end_turn');
  const sent = JSON.parse(last.body);
  assertEquals(sent.model, 'claude-haiku-4-5-20251001');
  assertEquals(sent.system[0].cache_control, { type: 'ephemeral' });
  assertEquals(sent.tools.length, 1);
});

Deno.test('callClaude: throws on 4xx with body excerpt', async () => {
  const { fetch } = makeFetch({ error: { message: 'bad' } }, 400);
  try {
    await callClaude({
      fetch,
      apiKey: 'sk-fake',
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
    });
    throw new Error('expected throw');
  } catch (e) {
    assertEquals(String(e).includes('claude 400'), true);
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/agent/claude.ts

export type ClaudeFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface ClaudeSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ClaudeUserMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

export interface CallClaudeInput {
  fetch: ClaudeFetch;
  apiKey: string;
  system: ClaudeSystemBlock[];
  messages: ClaudeUserMessage[];
  tools?: unknown[];
  model?: string;
  maxTokens?: number;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface CallClaudeResult {
  content: Array<Record<string, unknown>>;
  usage: ClaudeUsage;
  stop_reason: string;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;

export async function callClaude(input: CallClaudeInput): Promise<CallClaudeResult> {
  const body: Record<string, unknown> = {
    model: input.model ?? DEFAULT_MODEL,
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: input.system,
    messages: input.messages,
  };
  if (input.tools && input.tools.length > 0) body.tools = input.tools;

  const res = await input.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`claude ${res.status}: ${detail.slice(0, 300)}`);
  }
  const j = (await res.json()) as {
    content?: Array<Record<string, unknown>>;
    usage?: ClaudeUsage;
    stop_reason?: string;
  };
  return {
    content: j.content ?? [],
    usage: j.usage ?? { input_tokens: 0, output_tokens: 0 },
    stop_reason: j.stop_reason ?? 'unknown',
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/claude.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/claude.ts supabase/functions/_shared/agent/claude.test.ts
git commit -m "feat(agent): anthropic messages api caller for agent-runner"
```

---

## Task 10: Mail-triage prompt + tool catalog builder

**Files:**
- Create: `supabase/functions/_shared/agent/prompt.ts`, `supabase/functions/_shared/agent/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/agent/prompt.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildMailTriagePrompt, MAIL_TRIAGE_TOOLS } from './prompt.ts';

Deno.test('MAIL_TRIAGE_TOOLS exposes exactly four mail actions', () => {
  const names = MAIL_TRIAGE_TOOLS.map((t) => t.name).sort();
  assertEquals(names, [
    'mail.archive',
    'mail.flag_important',
    'mail.label',
    'mail.summarize',
  ]);
});

Deno.test('buildMailTriagePrompt: includes each thread with subject and from', () => {
  const { system, messages } = buildMailTriagePrompt({
    threads: [
      { thread_id: 't1', from: 'a@x.com', subject: 'Faktura', snippet: '' },
      { thread_id: 't2', from: 'b@y.com', subject: 'Hej', snippet: '' },
    ],
  });
  assertEquals(system.length >= 1, true);
  assertEquals(system[0].cache_control, { type: 'ephemeral' });
  const userText = (messages[0].content as string);
  assertEquals(userText.includes('t1'), true);
  assertEquals(userText.includes('Faktura'), true);
  assertEquals(userText.includes('t2'), true);
});

Deno.test('buildMailTriagePrompt: empty threads still produces a prompt', () => {
  const { messages } = buildMailTriagePrompt({ threads: [] });
  assertEquals(typeof messages[0].content, 'string');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/agent/prompt.ts
import type { ClaudeSystemBlock, ClaudeUserMessage } from './claude.ts';

export interface ThreadBrief {
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
}

export const MAIL_TRIAGE_TOOLS: ReadonlyArray<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> = [
  {
    name: 'mail.archive',
    description:
      'Archive a thread the user has clearly already handled (newsletters, receipts, automated notifications). Removes INBOX label only — recoverable.',
    input_schema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
    },
  },
  {
    name: 'mail.label',
    description:
      'Apply or remove a Gmail label on a thread. Use existing labels when present; create only short, clear category names like "Kvitteringer", "Nyhedsbreve", "Rejser".',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        label: { type: 'string' },
        op: { type: 'string', enum: ['add', 'remove'] },
      },
      required: ['thread_id', 'label', 'op'],
    },
  },
  {
    name: 'mail.flag_important',
    description:
      'Mark a thread as important (applies the "Zolva flaggede" label). Use sparingly: only when the message likely needs the user\'s attention today.',
    input_schema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
    },
  },
  {
    name: 'mail.summarize',
    description:
      'Write a one- to two-sentence Danish summary of the thread. Use when the subject alone does not convey what action (if any) the user needs to take. Summary must be ≤ 200 chars.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        summary: { type: 'string', maxLength: 200 },
      },
      required: ['thread_id', 'summary'],
    },
  },
];

const SYSTEM_PROMPT = `Du er Zolva — en personlig assistent der triage'r brugerens indbakke i baggrunden. Skriv aldrig svar; du må kun:
1. arkivere åbenlyst færdige tråde (kvitteringer, nyhedsbreve, automatiserede beskeder),
2. tilføje en kort kategori-label,
3. markere en tråd som vigtig (max 1-2 per kørsel),
4. skrive en kort dansk opsummering (max 200 tegn) hvis emnet alene ikke siger hvad brugeren skal gøre.

Regler:
- Brug kun thread_id'er fra listen i brugerens besked. Opfind ALDRIG ID'er.
- Vær konservativ: hvis du er i tvivl, gør ingenting.
- Du kan kalde flere værktøjer i samme tur. Stop når listen er triageret.
- Svar på dansk i den korte tekstkommentar efter værktøjskald.`;

export interface BuildMailTriagePromptInput {
  threads: ThreadBrief[];
}

export interface BuildMailTriagePromptResult {
  system: ClaudeSystemBlock[];
  messages: ClaudeUserMessage[];
}

export function buildMailTriagePrompt(
  input: BuildMailTriagePromptInput,
): BuildMailTriagePromptResult {
  const system: ClaudeSystemBlock[] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  const body = input.threads.length === 0
    ? 'Ingen nye tråde. Returnér en kort tekstbekræftelse uden værktøjskald.'
    : [
        'Triager følgende tråde:',
        '',
        ...input.threads.map((t) =>
          `- thread_id=${t.thread_id} | from=${t.from} | subject=${t.subject}${t.snippet ? ` | snippet=${t.snippet.slice(0, 120)}` : ''}`,
        ),
      ].join('\n');
  const messages: ClaudeUserMessage[] = [{ role: 'user', content: body }];
  return { system, messages };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/prompt.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/prompt.ts supabase/functions/_shared/agent/prompt.test.ts
git commit -m "feat(agent): mail-triage tool catalog + danish system prompt"
```

---

## Task 11: Replace the no-op runner with the real Claude/tool loop

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts`, `supabase/functions/_shared/agent/runner.test.ts`

The runner now: loads thread context for each `mail.new` event, builds the prompt, calls Claude, loops `tool_use` blocks (capped at 3 iterations), executes each through the dispatcher, writes an `agent_actions` row per executed tool, and finishes the run with usage totals. Failures inside a single tool call don't abort the run — they're logged into `agent_runs.error` and the run continues with the remaining tools.

- [ ] **Step 1: Write the failing test**

Append to `supabase/functions/_shared/agent/runner.test.ts`:

```ts
// Phase-2 path: Claude returns one mail.archive tool_use; runner executes
// it via the stubbed dispatcher and records an action.
import { CallClaudeResult } from './claude.ts';

Deno.test('runAgent: phase-2 path executes one tool call', async () => {
  let claudeCalls = 0;
  let recordedAction: { action_type: string; payload: Record<string, unknown> } | null = null;
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
```

In the same file, **update `makeDeps` from the existing test** to provide the new optional deps as no-ops by default. Replace the existing `makeDeps` with:

```ts
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
```

- [ ] **Step 2: Run and watch the new tests fail**

Run: `deno test supabase/functions/_shared/agent/runner.test.ts`
Expected: existing 2 tests pass; the 3 new tests fail because `RunnerDeps` doesn't yet expose `checkBudget`, `loadThreadBriefs`, `callClaudeTurn`, `executeTool`, `recordAction`, `incrementBudget`.

- [ ] **Step 3: Re-implement `runner.ts` with the Phase-2 loop**

Replace the entire file:

```ts
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
        const threadId = typeof tu.input.thread_id === 'string' ? tu.input.thread_id : '';
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
          const exec = await deps.executeTool(action, tu.input);
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

  await deps.markProcessed(eventIds);
  await deps.incrementBudget(userId, usage);
  await deps.finishRun(
    runId,
    runError ? 'error' : 'ok',
    usage,
    runError,
  );

  return {
    runId,
    processed: events.length,
    status: runError ? 'error' : 'ok',
  };
}
```

- [ ] **Step 4: Run all runner tests**

Run: `deno test supabase/functions/_shared/agent/runner.test.ts`
Expected: 5 tests passing (2 existing legacy tests still pass with the no-op defaults; 3 new phase-2 tests pass).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts supabase/functions/_shared/agent/runner.test.ts
git commit -m "feat(agent): replace no-op runner with mail-triage claude+tool loop"
```

---

## Task 12: Wire real deps into `agent-tick/index.ts`

**Files:**
- Modify: `supabase/functions/agent-tick/index.ts`

The edge function now needs to construct the Phase-2 RunnerDeps: an Anthropic API key, a Gmail access-token loader (reusing `loadRefreshToken` + `refreshAccessToken` from `_shared/oauth.ts`), a thread-brief loader, the Claude caller, the tool dispatcher, the budget helpers, and the action recorder. We do **not** cache anything across users — each iteration of the user loop builds a fresh deps object.

- [ ] **Step 1: Rewrite the deps builder**

Open `supabase/functions/agent-tick/index.ts` and replace the entire `buildDeps` function with:

```ts
import { runAgent } from '../_shared/agent/runner.ts';
import type { ClaimedEvent, RunnerDeps } from '../_shared/agent/runner.ts';
import type { AgentRunTrigger, ActionType } from '../_shared/agent/types.ts';
import { loadTodayBudget, incrementBudget, DEFAULT_LIMITS } from '../_shared/agent/budget.ts';
import { callClaude } from '../_shared/agent/claude.ts';
import { executeTool as dispatchTool } from '../_shared/agent/tools/dispatch.ts';
import { resolveLabelId } from '../_shared/agent/tools/gmail.ts';
import type { ThreadBrief } from '../_shared/agent/prompt.ts';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';

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
```

- [ ] **Step 2: Type-check**

Run: `deno check supabase/functions/agent-tick/index.ts`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/agent-tick/index.ts
git commit -m "feat(agent): wire real runner deps (gmail, claude, budget, idem) in agent-tick"
```

---

## Task 13: Integration smoke — end-to-end mail.new → action

**Files:**
- None (manual local smoke; documented for future runs).

- [ ] **Step 1: Boot local Supabase + agent-tick + a stub Anthropic key**

```bash
supabase start
supabase functions serve agent-tick --env-file ./supabase/.env.local
```

`.env.local` must have:
```
CRON_SHARED_SECRET=test-secret
SUPABASE_URL=http://host.docker.internal:54321
SUPABASE_SERVICE_ROLE_KEY=<from supabase start output>
ANTHROPIC_API_KEY=<real key — Claude is invoked>
```

- [ ] **Step 2: Seed a synthetic Gmail thread + event**

Because this smoke calls Gmail for real, you'll need a real google watcher row + a real thread_id from your own inbox. On your dev device, sign in with `albertfeldt1@gmail.com` (memory `user_test_accounts`), then in psql:

```bash
psql "$LOCAL_DB_URL" <<'SQL'
-- Replace 'd02f1514-...' with the real test user id and 't-xxxx' with a
-- real Gmail thread id you want to triage. Use a low-stakes newsletter
-- thread you don't mind getting archived.
insert into public.agent_events (user_id, kind, payload)
  values (
    'd02f1514-...',
    'mail.new',
    jsonb_build_object(
      'provider','google',
      'thread_id','t-xxxx',
      'message_id','m-xxxx',
      'from','newsletter@example.com',
      'subject','Weekly digest'
    )
  );
SQL
```

- [ ] **Step 3: Trigger the function as cron**

```bash
curl -sX POST http://localhost:54321/functions/v1/agent-tick \
  -H 'x-cron-secret: test-secret' | jq
```
Expected: `{"ok":true,"results":[{"userId":"d02f1514-...","runId":"...","processed":1,"status":"ok"}]}`

- [ ] **Step 4: Verify an `agent_actions` row was written**

```bash
psql "$LOCAL_DB_URL" -c "select action_type, payload->>'thread_id' as tid, reversible from agent_actions order by executed_at desc limit 5;"
```
Expected: at least one row with `action_type` ∈ `{mail.archive, mail.label, mail.flag_important, mail.summarize}` and `tid='t-xxxx'`.

- [ ] **Step 5: Verify the thread changed in Gmail**

Open Gmail in a browser — the test thread should have moved out of INBOX (archived) and/or had a label applied.

- [ ] **Step 6: Verify rerun is idempotent**

Re-issue the same curl. Expected: `processed: 0` (the event is already marked, the agent_actions row is dedup'd by `idem_key`).

- [ ] **Step 7: Commit the smoke procedure note**

In `supabase/functions/agent-tick/index.ts`, **update** the existing header comment to:

```ts
// Smoke test: see docs/superpowers/plans/2026-05-12-autonomous-agent-phase-2-mail-triage.md task 13.
```

```bash
git add supabase/functions/agent-tick/index.ts
git commit -m "test(agent): document phase-2 agent-tick local smoke procedure"
```

---

## Task 14: `agent-undo` edge function

**Files:**
- Create: `supabase/functions/agent-undo/index.ts`, `supabase/functions/agent-undo/deno.json`

- [ ] **Step 1: Copy the deno config**

```bash
cp supabase/functions/agent-tick/deno.json supabase/functions/agent-undo/deno.json
```

- [ ] **Step 2: Write the function**

Create `supabase/functions/agent-undo/index.ts`:

```ts
// agent-undo - reverse a previously-executed agent_action.
//
// JWT-authenticated only (no cron path; users initiate undos themselves).
// Atomically claims the action via agent_revert_action so a double-tap
// can't double-revert, then applies the reverse_token against the provider.
//
// Phase 2 supports only `gmail.modify` reverse tokens.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import { gmailModifyThread } from '../_shared/agent/tools/gmail.ts';
import type { GmailModifyReverseToken } from '../_shared/agent/tools/gmail.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

async function applyReverseToken(
  client: SupabaseClient,
  userId: string,
  token: GmailModifyReverseToken,
): Promise<void> {
  if (token.kind !== 'gmail.modify') {
    throw new Error(`unsupported reverse_token kind ${token.kind}`);
  }
  const refresh = await loadRefreshToken(client, userId, 'google');
  if (!refresh) throw new Error('no google refresh token for user');
  const { accessToken } = await refreshAccessToken(client, userId, 'google', refresh);
  await gmailModifyThread({
    fetch: fetch as never,
    accessToken,
    threadId: token.thread_id,
    addLabelIds: token.add_label_ids,
    removeLabelIds: token.remove_label_ids,
  });
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const userId = await authenticatedUserId(req);
  if (!userId) return new Response('unauthorized', { status: 401 });

  let body: { action_id?: string };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const actionId = body.action_id;
  if (!actionId) return new Response('action_id required', { status: 400 });

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data, error } = await client.rpc('agent_revert_action', {
    p_action_id: actionId,
    p_user_id: userId,
  });
  if (error) {
    console.error('[agent-undo] rpc error', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }
  const row = (data ?? [])[0] as
    | { claimed: boolean; action_type: string; reverse_token: GmailModifyReverseToken | null }
    | undefined;
  if (!row?.claimed) {
    // Either nonexistent, foreign user, already-reverted, or not reversible.
    return new Response(JSON.stringify({ ok: false, reason: 'not_reversible' }), { status: 200 });
  }
  if (!row.reverse_token) {
    return new Response(JSON.stringify({ ok: true, reverted: true, note: 'no-op' }), { status: 200 });
  }
  try {
    await applyReverseToken(client, userId, row.reverse_token);
  } catch (e) {
    // Undo failed against provider — the row is already marked reversed,
    // but the user-visible state is now inconsistent. Surface clearly.
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-undo] provider error', msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 502 });
  }
  return new Response(JSON.stringify({ ok: true, reverted: true }), { status: 200 });
});
```

- [ ] **Step 3: Type-check**

Run: `deno check supabase/functions/agent-undo/index.ts`
Expected: no output.

- [ ] **Step 4: Smoke against local supabase**

```bash
supabase functions serve agent-undo --env-file ./supabase/.env.local
# Substitute your dev JWT + the action_id from Task 13 step 4.
curl -sX POST http://localhost:54321/functions/v1/agent-undo \
  -H "authorization: Bearer $DEV_USER_JWT" \
  -H "content-type: application/json" \
  -d '{"action_id":"<uuid>"}' | jq
psql "$LOCAL_DB_URL" -c "select id, reversed_at from agent_actions where id = '<uuid>';"
```
Expected: response `{"ok":true,"reverted":true}`; `reversed_at` populated; the Gmail thread is back in INBOX (or label removed).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/agent-undo/
git commit -m "feat(agent): agent-undo edge function for reversing agent_actions"
```

---

## Task 15: Client `useAgentActions` hook

**Files:**
- Create: `src/lib/agent-feed.ts`, `src/lib/__tests__/agent-feed.test.ts`

Phase 2 only needs `agent_actions` (auto-executed); `proposed_actions` is Phase 3.

- [ ] **Step 1: Write the failing test (reducer pieces only — supabase is hard to mock here)**

```ts
// src/lib/__tests__/agent-feed.test.ts
import { mergeAgentActions, type AgentActionRow } from '../agent-feed';

const row = (id: string, executed: string, reversed: string | null = null): AgentActionRow => ({
  id,
  action_type: 'mail.archive',
  payload: { thread_id: 't1' },
  executed_at: executed,
  reversible: true,
  reverse_token: { kind: 'gmail.modify', thread_id: 't1', add_label_ids: ['INBOX'], remove_label_ids: [] },
  reversed_at: reversed,
});

describe('mergeAgentActions', () => {
  it('replaces matching row by id', () => {
    const before = [row('a', '2026-05-12T10:00:00Z'), row('b', '2026-05-12T11:00:00Z')];
    const merged = mergeAgentActions(before, row('b', '2026-05-12T11:00:00Z', '2026-05-12T12:00:00Z'));
    expect(merged.find((r) => r.id === 'b')?.reversed_at).toBe('2026-05-12T12:00:00Z');
    expect(merged).toHaveLength(2);
  });
  it('prepends new row in descending executed_at order', () => {
    const before = [row('a', '2026-05-12T10:00:00Z')];
    const merged = mergeAgentActions(before, row('b', '2026-05-12T11:00:00Z'));
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });
  it('does not show reverted rows in the feed by default', () => {
    const r1 = row('a', '2026-05-12T10:00:00Z', '2026-05-12T10:05:00Z');
    const r2 = row('b', '2026-05-12T11:00:00Z');
    expect(mergeAgentActions([r1, r2], r1).filter((r) => !r.reversed_at).map((r) => r.id)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- agent-feed`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/agent-feed.ts
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface AgentActionRow {
  id: string;
  action_type:
    | 'mail.label'
    | 'mail.archive'
    | 'mail.flag_important'
    | 'mail.summarize';
  payload: Record<string, unknown>;
  executed_at: string;
  reversible: boolean;
  reverse_token: Record<string, unknown> | null;
  reversed_at: string | null;
}

export function mergeAgentActions(
  existing: AgentActionRow[],
  incoming: AgentActionRow,
): AgentActionRow[] {
  const without = existing.filter((r) => r.id !== incoming.id);
  const next = [...without, incoming];
  next.sort((a, b) => (a.executed_at < b.executed_at ? 1 : -1));
  return next;
}

export function useAgentActions(userId: string | null | undefined): {
  rows: AgentActionRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<AgentActionRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setLoading(false);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('agent_actions')
        .select('id, action_type, payload, executed_at, reversible, reverse_token, reversed_at')
        .eq('user_id', userId)
        .order('executed_at', { ascending: false })
        .limit(20);
      if (cancelled) return;
      if (error) console.warn('[agent-feed] read failed:', error.message);
      setRows((data ?? []) as AgentActionRow[]);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`agent_actions:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_actions', filter: `user_id=eq.${userId}` },
        (payload) => {
          const next = payload.new as AgentActionRow;
          if (!next || !next.id) return;
          setRows((prev) => mergeAgentActions(prev, next));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return { rows, loading };
}

export async function revertAgentAction(actionId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, error: 'no session' };
  const baseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl;
  const res = await fetch(`${baseUrl}/functions/v1/agent-undo`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action_id: actionId }),
  });
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  const j = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: !!j.ok, error: j.error };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- agent-feed`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-feed.ts src/lib/__tests__/agent-feed.test.ts
git commit -m "feat(agent): useAgentActions hook + revertAgentAction client helper"
```

---

## Task 16: `<AgentActionCard>` + `<TodayAgentFeed>` components

**Files:**
- Create: `src/components/AgentActionCard.tsx`, `src/components/TodayAgentFeed.tsx`

- [ ] **Step 1: Build `AgentActionCard`**

Create `src/components/AgentActionCard.tsx`:

```tsx
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { revertAgentAction, type AgentActionRow } from '../lib/agent-feed';
import { colors } from '../theme';

const TITLES: Record<AgentActionRow['action_type'], string> = {
  'mail.archive': 'Arkiveret',
  'mail.label': 'Mærket',
  'mail.flag_important': 'Markeret som vigtig',
  'mail.summarize': 'Opsummeret',
};

function detailFor(row: AgentActionRow): string {
  switch (row.action_type) {
    case 'mail.summarize': {
      const s = row.payload.summary;
      return typeof s === 'string' ? s : '';
    }
    case 'mail.label': {
      const l = row.payload.label;
      const op = row.payload.op;
      return typeof l === 'string' ? `${op === 'remove' ? 'Fjernet' : 'Tilføjet'}: ${l}` : '';
    }
    default:
      return '';
  }
}

export function AgentActionCard({ row }: { row: AgentActionRow }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isReverted = !!row.reversed_at;

  async function onUndo() {
    setPending(true);
    setError(null);
    const r = await revertAgentAction(row.id);
    setPending(false);
    if (!r.ok) setError(r.error ?? 'fejl');
  }

  return (
    <View style={styles.card} accessibilityLabel={`agent-action-${row.action_type}`}>
      <View style={styles.row}>
        <Text style={styles.badge}>✓ Udført</Text>
        <Text style={styles.title}>{TITLES[row.action_type]}</Text>
      </View>
      {detailFor(row) ? <Text style={styles.detail}>{detailFor(row)}</Text> : null}
      <View style={styles.actions}>
        {row.reversible && !isReverted ? (
          <Pressable onPress={onUndo} disabled={pending} accessibilityLabel="undo">
            {pending ? <ActivityIndicator size="small" /> : <Text style={styles.undo}>Fortryd</Text>}
          </Pressable>
        ) : isReverted ? (
          <Text style={styles.muted}>Fortrudt</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paperDeep,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 8,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { color: colors.fg3, fontSize: 12, fontWeight: '600' },
  title: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  detail: { color: colors.fg3, fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  undo: { color: colors.ink, fontSize: 14, fontWeight: '500', textDecorationLine: 'underline' },
  muted: { color: colors.fg3, fontSize: 13 },
  error: { color: '#A24', fontSize: 12 },
});
```

- [ ] **Step 2: Build `TodayAgentFeed`**

Create `src/components/TodayAgentFeed.tsx`:

```tsx
import React from 'react';
import { View } from 'react-native';
import { useAgentActions } from '../lib/agent-feed';
import { useAuth } from '../lib/auth';
import { AgentActionCard } from './AgentActionCard';
import { AgentEmptyState } from './AgentEmptyState';

export function TodayAgentFeed() {
  const { user } = useAuth();
  const { rows, loading } = useAgentActions(user?.id);
  const visible = rows.filter((r) => !r.reversed_at);
  if (loading || visible.length === 0) return <AgentEmptyState />;
  return (
    <View>
      {visible.map((r) => (
        <AgentActionCard key={r.id} row={r} />
      ))}
    </View>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors (modulo the pre-existing TS2322 in `hooks.ts:5037` per memory `project_preexisting_ts_error` — ignore that).

- [ ] **Step 4: Commit**

```bash
git add src/components/AgentActionCard.tsx src/components/TodayAgentFeed.tsx
git commit -m "feat(agent): today feed cards with undo for executed agent actions"
```

---

## Task 17: TodayScreen — swap empty state for feed

**Files:**
- Modify: `src/screens/TodayScreen.tsx`

- [ ] **Step 1: Swap the import + render**

In `src/screens/TodayScreen.tsx`:
1. Find `import { AgentEmptyState } from '../components/AgentEmptyState';` and **replace** it with:
```ts
import { TodayAgentFeed } from '../components/TodayAgentFeed';
```
2. Find the JSX `<AgentEmptyState />` (Phase-1 placement; per Explore agent's audit this is around the BriefBanner block). Replace it with:
```tsx
<TodayAgentFeed />
```

`TodayAgentFeed` internally falls back to the empty state when there are no rows, so the empty-state experience is preserved when the agent hasn't done anything yet.

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Manual verification on dev build**

```bash
npx expo start --clear
```
Sign in, open Today tab.
- Initial state (no agent_actions yet): empty card "Zolva er klar".
- After Task-13 smoke runs against your dev DB: card list appears with the action(s) executed.
- Tap Fortryd → row updates to "Fortrudt"; Gmail thread restored.

- [ ] **Step 4: Commit**

```bash
git add src/screens/TodayScreen.tsx
git commit -m "feat(agent): today screen renders agent feed with empty-state fallback"
```

---

## Task 18: Deploy server, apply migration + cron, then OTA the client

Per memory `project_client_server_pr_split.md` the server changes commit and deploy **first**, then the client OTA. Per `project_build_from_main.md`, OTA ships from `main`.

- [ ] **Step 1: Push current branch and merge to main**

```bash
git push origin HEAD
# If working on a feature branch:
# git checkout main && git merge --no-ff <branch> -m "feat(agent): phase 2 mail triage"
git push origin main
```

- [ ] **Step 2: Push the migration**

```bash
supabase link --project-ref sjkhfkatmeqtsrysixop
supabase db push
supabase migration list --linked | tail -5
```
Expected: `20260512180000_agent_phase2` listed as applied.

- [ ] **Step 3: Apply the cron template (manual paste)**

Open `supabase/schedule-agent-tick.sql.template`. Copy the SQL into the Supabase Dashboard → SQL editor for project `sjkhfkatmeqtsrysixop`, replacing `PASTE_SERVICE_ROLE_KEY` and `PASTE_CRON_SHARED_SECRET` with real values. Run.

Verify:
```bash
supabase db remote query "select jobname, schedule from cron.job where jobname = 'agent-tick-every-min';"
```
Expected: one row, schedule `* * * * *`.

- [ ] **Step 4: Deploy `agent-tick` (with the new deps) + `agent-undo`**

```bash
supabase functions deploy agent-tick --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
supabase functions deploy agent-undo --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

`--no-verify-jwt` per memory `project_supabase_asymmetric_jwt`. `agent-undo` does its own JWT check via `auth.getUser()`; the gateway flag just lets the request through.

- [ ] **Step 5: Deploy the updated `poll-mail`**

```bash
supabase functions deploy poll-mail --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

- [ ] **Step 6: Smoke against production**

```bash
curl -sX POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/agent-tick" \
  -H "x-cron-secret: $CRON_SHARED_SECRET" | jq
```
Expected: `{"ok":true,"results":[...]}`. With pending events for active users, expect non-empty `results`; without, `results: []` is correct.

- [ ] **Step 7: Ship the client OTA**

```bash
eas update --branch production --message "feat(agent): phase 2 mail triage feed + undo"
```

- [ ] **Step 8: End-to-end verification on a real device**

On test account `albertfeldt1@gmail.com` (memory `user_test_accounts`):
1. Pull OTA, open Today tab.
2. Trigger by sending yourself a newsletter-style mail.
3. Wait up to 2 minutes (1 min for `poll-mail`, 1 min for `agent-tick`).
4. Today tab should show one or more "✓ Udført" cards.
5. Tap Fortryd → card flips to "Fortrudt"; the original Gmail state is restored.

- [ ] **Step 9: Final status check**

```bash
git log -1 --oneline
git status
psql "$REMOTE_DB_URL" -c "select count(*) from agent_runs where started_at > now() - interval '1 hour';"
```
Expected: working tree clean; at least one run in the last hour.

---

## Definition of done

- [ ] Migration `20260512180000_agent_phase2` applied locally + production.
- [ ] `agent-tick` (real runner), `agent-undo`, `poll-mail` (event-emitting) deployed.
- [ ] `agent-tick-every-min` cron entry present in `cron.job`.
- [ ] `poll-mail` writes `agent_events` rows with `kind='mail.new'` for google watchers.
- [ ] One end-to-end run on production produces `agent_actions` rows visible in the Today tab.
- [ ] Undo button restores the Gmail thread state and flips `reversed_at`.
- [ ] All new Deno tests pass (`deno test supabase/functions/_shared/agent/ supabase/functions/agent-tick/ supabase/functions/poll-mail/`).
- [ ] All new Jest tests pass (`npm test -- agent-feed`).
- [ ] No regression in existing tests (`npm test`).
- [ ] Phase-1 carry-over #1 closed: `v_users_with_pending_agent_events` excludes opted-out users.

---

## What Phase 2.1 will plug in on top of this

- **Outlook (Microsoft Graph) triage**: extend `buildMailNewEventRows` to include `microsoft`, add `_shared/agent/tools/outlook.ts` (move-to-folder for archive, category assignment for label/flag), broaden `executeTool` dispatch. No schema changes; reuse the `reverse_token` shape with `kind: 'graph.move' | 'graph.category'`.
- **iCloud triage**: tighter scope — IMAP STORE FLAGS for flag, folder move for archive. Likely skipped until iCloud has higher mail-volume usage.
- **`AgentEnabled = false` short-circuit at the producer**: skip event emission in `poll-mail` when the user has opted out (currently we emit and filter in the view; tiny extra cost).
- **`v_agent_recent_runs` enrichment**: include action counts per run for a future "agent activity" admin view.

## What Phase 3 will plug in on top of this

- `mail.draft_reply` (auto) + `mail.send_reply` (propose).
- `proposed_actions` table actually populated; push notifications + Today section for pending proposals.
- Per-action policy UI in Settings (three-way picker per action type).
