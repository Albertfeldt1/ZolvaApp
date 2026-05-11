# Autonomous Agent — Phase 1 (Plumbing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the foundational tables, edge-function skeleton, client presence ping, and Settings kill-switch for the autonomous-actions feature. Phase 1 ships the *pipes* — no real Claude calls, no real actions; everything wires through but is a no-op so Phase 2 can plug in mail-triage logic without re-architecting.

**Architecture:** Postgres tables in a single migration, a shared Deno `_shared/agent/` module (policy resolver + budget tracker + no-op runner), a new `agent-tick` edge function gated by cron secret, an `AppState` heartbeat from the Expo client to a new `user_presence` table, and minimal additions to existing `TodayScreen` + `SettingsScreen`.

**Tech Stack:** Supabase Postgres + RLS, Deno edge functions, Expo / React Native, Jest (client), Deno test (edge functions).

**Spec:** `docs/superpowers/specs/2026-05-11-autonomous-background-actions-design.md`

---

## File structure

### Created
- `supabase/migrations/20260511180000_agent_foundations.sql` — all 7 agent tables, RLS, `user_profiles.agent_enabled` column, helper views.
- `supabase/functions/_shared/agent/types.ts` — TypeScript types for agent events, action types, policy modes, runner I/O.
- `supabase/functions/_shared/agent/policy.ts` — trust-policy resolver (`resolvePolicy(actionType, userPolicyRows)` → mode).
- `supabase/functions/_shared/agent/policy.test.ts` — Deno unit tests for the resolver.
- `supabase/functions/_shared/agent/budget.ts` — budget reader + incrementer.
- `supabase/functions/_shared/agent/budget.test.ts` — Deno unit tests for budget.
- `supabase/functions/_shared/agent/runner.ts` — no-op runner: claims events, writes one `agent_runs` row, marks events processed. No Claude call yet.
- `supabase/functions/_shared/agent/runner.test.ts` — Deno tests for the no-op behaviour + advisory lock.
- `supabase/functions/agent-tick/index.ts` — HTTP entry: cron-secret check + per-user advisory lock + dispatches to runner.
- `supabase/functions/agent-tick/deno.json` — deno config (copy of an existing function's).
- `src/lib/presence.ts` — `markActive()` / `markBackground()` helpers + AppState listener registration.
- `src/lib/__tests__/presence.test.ts` — Jest tests for presence helpers.
- `src/lib/agent-settings.ts` — `getAgentEnabled()` / `setAgentEnabled()` helpers + `useAgentEnabled()` hook.
- `src/lib/__tests__/agent-settings.test.ts` — Jest tests for the hook reducer.
- `src/components/ZolvaHandlingerSection.tsx` — Settings UI block.

### Modified
- `App.tsx` — register presence listener on app boot.
- `src/screens/SettingsScreen.tsx` — import + render `<ZolvaHandlingerSection />`.
- `src/screens/TodayScreen.tsx` — small empty-state insertion only (`<AgentEmptyState />` component).

### Not in this plan (Phase 2+)
- Event producers (`poll-mail` writing `mail.new` events) — Phase 2.
- Action execution (mail.label, mail.archive…) — Phase 2.
- `agent-reflect` cron-driven sweeps — Phase 4.

---

## Task 1: Migration — agent foundation tables

**Files:**
- Create: `supabase/migrations/20260511180000_agent_foundations.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260511180000_agent_foundations.sql

-- Autonomous-agent foundations: tables that back the background agent
-- loop introduced in spec 2026-05-11. Phase 1 lands the schema + RLS
-- only; no producers/consumers run real workloads yet (Phase 2+).

-- Global kill-switch column on user_profiles. Default on so the rollout
-- is wide-open; users can flip from Settings.
alter table public.user_profiles
  add column if not exists agent_enabled boolean not null default true;

-- 1. Event queue feeding the agent.
create table if not exists public.agent_events (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  batch_id     uuid
);
create index if not exists agent_events_pending_idx
  on public.agent_events (user_id, processed_at)
  where processed_at is null;

-- 2. One row per runner invocation.
create table if not exists public.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  trigger       text not null,
  event_ids     bigint[] not null default '{}',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null check (status in ('running','ok','error','budget_exceeded')),
  input_tokens  int,
  output_tokens int,
  error         text
);
create index if not exists agent_runs_user_started_idx
  on public.agent_runs (user_id, started_at desc);

-- 3. Per-user × per-action-type trust policy.
create table if not exists public.user_agent_policy (
  user_id     uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  mode        text not null check (mode in ('auto','propose','off')),
  updated_at  timestamptz not null default now(),
  primary key (user_id, action_type)
);

-- 4. Things the agent wants to do but is waiting on the user.
create table if not exists public.proposed_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  run_id      uuid references public.agent_runs(id),
  action_type text not null,
  payload     jsonb not null,
  preview     jsonb not null,
  status      text not null check (status in ('pending','approved','dismissed','expired','executed','failed')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  executed_at timestamptz,
  expires_at  timestamptz,
  context_ref jsonb
);
create index if not exists proposed_actions_user_status_idx
  on public.proposed_actions (user_id, status, created_at desc);

-- 5. Activity log: every executed action (auto or approved), with Undo.
create table if not exists public.agent_actions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  run_id        uuid references public.agent_runs(id),
  proposal_id   uuid references public.proposed_actions(id),
  action_type   text not null,
  payload       jsonb not null,
  executed_at   timestamptz not null default now(),
  reversible    boolean not null default false,
  reverse_token jsonb,
  reversed_at   timestamptz
);
create index if not exists agent_actions_user_exec_idx
  on public.agent_actions (user_id, executed_at desc);
create unique index if not exists agent_actions_idem
  on public.agent_actions (user_id, action_type, (payload->>'idem_key'))
  where payload->>'idem_key' is not null;

-- 6. Daily token budget per user.
create table if not exists public.user_agent_budget (
  user_id       uuid not null references auth.users(id) on delete cascade,
  day           date not null,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  primary key (user_id, day)
);

-- 7. App presence — drives the `user.idle` signal.
create table if not exists public.user_presence (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  last_active_at   timestamptz,
  last_app_open_at timestamptz,
  push_token       text,
  updated_at       timestamptz not null default now()
);

-- RLS: every table is service-role-only for writes; users read their own rows
-- via authenticated select policies.

alter table public.agent_events       enable row level security;
alter table public.agent_runs         enable row level security;
alter table public.user_agent_policy  enable row level security;
alter table public.proposed_actions   enable row level security;
alter table public.agent_actions      enable row level security;
alter table public.user_agent_budget  enable row level security;
alter table public.user_presence      enable row level security;

create policy "owner-select-agent-events" on public.agent_events
  for select using (auth.uid() = user_id);
create policy "owner-select-agent-runs" on public.agent_runs
  for select using (auth.uid() = user_id);
create policy "owner-rw-user-agent-policy" on public.user_agent_policy
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner-select-proposed-actions" on public.proposed_actions
  for select using (auth.uid() = user_id);
create policy "owner-update-proposed-actions" on public.proposed_actions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner-select-agent-actions" on public.agent_actions
  for select using (auth.uid() = user_id);
create policy "owner-select-user-agent-budget" on public.user_agent_budget
  for select using (auth.uid() = user_id);
create policy "owner-rw-user-presence" on public.user_presence
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Observability views (security_invoker so they inherit caller RLS).
create or replace view public.v_agent_recent_runs
  with (security_invoker = on)
  as
  select id, user_id, trigger, status, started_at, finished_at,
         input_tokens, output_tokens, error
  from public.agent_runs
  order by started_at desc
  limit 100;

create or replace view public.v_agent_pending_proposals_age
  with (security_invoker = on)
  as
  select user_id,
         min(created_at) as oldest_pending_at,
         count(*)         as pending_count
  from public.proposed_actions
  where status = 'pending'
  group by user_id;
```

- [ ] **Step 2: Apply locally and smoke-test**

Run:
```bash
supabase db reset --local   # or `supabase migration up --local` if you don't want a reset
psql "$LOCAL_DB_URL" -c "\dt public.agent_*"
psql "$LOCAL_DB_URL" -c "\dt public.user_agent_*"
psql "$LOCAL_DB_URL" -c "\dt public.user_presence"
psql "$LOCAL_DB_URL" -c "select column_name from information_schema.columns where table_name = 'user_profiles' and column_name = 'agent_enabled';"
```
Expected: all 7 agent tables listed, `user_presence` listed, `agent_enabled` column present.

- [ ] **Step 3: Verify RLS denies cross-user reads**

```bash
psql "$LOCAL_DB_URL" -c "set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001'; select count(*) from agent_events;"
```
Expected: returns 0 (no error, no leakage of other users' rows).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260511180000_agent_foundations.sql
git commit -m "feat(agent): foundation tables, RLS, and agent_enabled flag"
```

---

## Task 2: Shared types module

**Files:**
- Create: `supabase/functions/_shared/agent/types.ts`

- [ ] **Step 1: Write the types**

```ts
// supabase/functions/_shared/agent/types.ts

export type AgentEventKind =
  | 'mail.new'
  | 'mail.replied'
  | 'calendar.changed'
  | 'calendar.upcoming'
  | 'fact.created'
  | 'fact.due'
  | 'time.morning'
  | 'time.midday'
  | 'time.evening'
  | 'time.sweep'
  | 'user.idle'
  | 'user.intent';

export type AgentRunTrigger =
  | 'tick'
  | 'reflect.morning'
  | 'reflect.midday'
  | 'reflect.evening'
  | 'reflect.sweep';

export type ActionType =
  | 'mail.label'
  | 'mail.archive'
  | 'mail.flag_important'
  | 'mail.summarize'
  | 'mail.draft_reply'
  | 'mail.send_reply'
  | 'mail.send_new'
  | 'cal.rsvp'
  | 'cal.create_event'
  | 'cal.update_event'
  | 'cal.suggest_times'
  | 'brief.compose'
  | 'nudge.push'
  | 'memory.followup_draft'
  | 'standing_task.create';

export type PolicyMode = 'auto' | 'propose' | 'off';

export type AgentRunStatus = 'running' | 'ok' | 'error' | 'budget_exceeded';

export interface AgentEvent {
  id: number;
  user_id: string;
  kind: AgentEventKind;
  payload: Record<string, unknown>;
  created_at: string;
  processed_at: string | null;
  batch_id: string | null;
}

export interface UserPolicyRow {
  user_id: string;
  action_type: ActionType;
  mode: PolicyMode;
}

// Default policy table - keyed by ActionType. Anything not listed
// here is treated as 'off' by resolvePolicy. Mirrors spec §5.1.
export const DEFAULT_POLICY: Record<ActionType, PolicyMode> = {
  'mail.label': 'auto',
  'mail.archive': 'auto',
  'mail.flag_important': 'auto',
  'mail.summarize': 'auto',
  'mail.draft_reply': 'auto',
  'mail.send_reply': 'propose',
  'mail.send_new': 'propose',
  'cal.rsvp': 'propose',
  'cal.create_event': 'propose',
  'cal.update_event': 'propose',
  'cal.suggest_times': 'auto',
  'brief.compose': 'auto',
  'nudge.push': 'auto',
  'memory.followup_draft': 'auto',
  'standing_task.create': 'propose',
};
```

- [ ] **Step 2: Type-check**

Run: `cd supabase/functions/_shared/agent && deno check types.ts`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/agent/types.ts
git commit -m "feat(agent): shared types module for events/actions/policy"
```

---

## Task 3: Policy resolver — test first

**Files:**
- Create: `supabase/functions/_shared/agent/policy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/agent/policy.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolvePolicy } from './policy.ts';

Deno.test('resolvePolicy: absent row returns spec default', () => {
  assertEquals(resolvePolicy('mail.label', []), 'auto');
  assertEquals(resolvePolicy('mail.send_reply', []), 'propose');
});

Deno.test('resolvePolicy: user override beats default', () => {
  const rows = [
    { user_id: 'u', action_type: 'mail.label' as const, mode: 'off' as const },
  ];
  assertEquals(resolvePolicy('mail.label', rows), 'off');
});

Deno.test('resolvePolicy: user can upgrade propose -> auto', () => {
  const rows = [
    { user_id: 'u', action_type: 'mail.send_reply' as const, mode: 'auto' as const },
  ];
  assertEquals(resolvePolicy('mail.send_reply', rows), 'auto');
});

Deno.test('resolvePolicy: only the row matching action_type wins', () => {
  const rows = [
    { user_id: 'u', action_type: 'mail.label' as const, mode: 'off' as const },
    { user_id: 'u', action_type: 'mail.archive' as const, mode: 'propose' as const },
  ];
  assertEquals(resolvePolicy('mail.archive', rows), 'propose');
  assertEquals(resolvePolicy('mail.flag_important', rows), 'auto');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/policy.test.ts`
Expected: FAIL with "Module not found: policy.ts" (or similar).

- [ ] **Step 3: Implement the resolver**

Create `supabase/functions/_shared/agent/policy.ts`:

```ts
import {
  ActionType,
  DEFAULT_POLICY,
  PolicyMode,
  UserPolicyRow,
} from './types.ts';

export function resolvePolicy(
  actionType: ActionType,
  rows: UserPolicyRow[],
): PolicyMode {
  const row = rows.find((r) => r.action_type === actionType);
  return row?.mode ?? DEFAULT_POLICY[actionType];
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/policy.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/policy.ts supabase/functions/_shared/agent/policy.test.ts
git commit -m "feat(agent): trust-policy resolver with spec defaults"
```

---

## Task 4: Budget tracker — test first

**Files:**
- Create: `supabase/functions/_shared/agent/budget.test.ts`, `supabase/functions/_shared/agent/budget.ts`

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/agent/budget.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isBudgetExceeded, BudgetSnapshot } from './budget.ts';

const limits = { dailyInput: 100_000, dailyOutput: 25_000 };

Deno.test('isBudgetExceeded: empty snapshot is fine', () => {
  const snap: BudgetSnapshot = { inputTokens: 0, outputTokens: 0 };
  assertEquals(isBudgetExceeded(snap, limits), false);
});

Deno.test('isBudgetExceeded: hits the input ceiling', () => {
  const snap: BudgetSnapshot = { inputTokens: 100_000, outputTokens: 0 };
  assertEquals(isBudgetExceeded(snap, limits), true);
});

Deno.test('isBudgetExceeded: hits the output ceiling', () => {
  const snap: BudgetSnapshot = { inputTokens: 0, outputTokens: 25_000 };
  assertEquals(isBudgetExceeded(snap, limits), true);
});

Deno.test('isBudgetExceeded: under both is fine', () => {
  const snap: BudgetSnapshot = { inputTokens: 99_999, outputTokens: 24_999 };
  assertEquals(isBudgetExceeded(snap, limits), false);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement budget helpers**

Create `supabase/functions/_shared/agent/budget.ts`:

```ts
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface BudgetSnapshot {
  inputTokens: number;
  outputTokens: number;
}

export interface BudgetLimits {
  dailyInput: number;
  dailyOutput: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  dailyInput: 100_000,
  dailyOutput: 25_000,
};

export function isBudgetExceeded(
  snap: BudgetSnapshot,
  limits: BudgetLimits,
): boolean {
  return snap.inputTokens >= limits.dailyInput
    || snap.outputTokens >= limits.dailyOutput;
}

// Load today's snapshot (UTC day) for a user. Returns zeros when no row exists.
export async function loadTodayBudget(
  client: SupabaseClient,
  userId: string,
): Promise<BudgetSnapshot> {
  const day = new Date().toISOString().slice(0, 10);
  const { data, error } = await client
    .from('user_agent_budget')
    .select('input_tokens, output_tokens')
    .eq('user_id', userId)
    .eq('day', day)
    .maybeSingle();
  if (error) throw error;
  return {
    inputTokens: data?.input_tokens ?? 0,
    outputTokens: data?.output_tokens ?? 0,
  };
}

// Idempotent additive upsert; safe under concurrent runs.
export async function incrementBudget(
  client: SupabaseClient,
  userId: string,
  add: BudgetSnapshot,
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const { error } = await client.rpc('agent_budget_increment', {
    p_user_id: userId,
    p_day: day,
    p_input: add.inputTokens,
    p_output: add.outputTokens,
  });
  if (error) throw error;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/budget.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Add the `agent_budget_increment` RPC to the migration**

`incrementBudget` calls an RPC we haven't defined yet. Append to the existing migration `supabase/migrations/20260511180000_agent_foundations.sql`:

```sql
-- Additive upsert used by edge fns to record token spend without races.
create or replace function public.agent_budget_increment(
  p_user_id uuid,
  p_day date,
  p_input int,
  p_output int
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.user_agent_budget (user_id, day, input_tokens, output_tokens)
  values (p_user_id, p_day, p_input, p_output)
  on conflict (user_id, day)
  do update set
    input_tokens  = public.user_agent_budget.input_tokens  + excluded.input_tokens,
    output_tokens = public.user_agent_budget.output_tokens + excluded.output_tokens;
$$;

revoke all on function public.agent_budget_increment(uuid, date, int, int) from public;
grant execute on function public.agent_budget_increment(uuid, date, int, int) to service_role;
```

Re-apply the migration locally:
```bash
supabase db reset --local
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/agent/budget.ts \
        supabase/functions/_shared/agent/budget.test.ts \
        supabase/migrations/20260511180000_agent_foundations.sql
git commit -m "feat(agent): daily budget tracker + RPC for atomic increment"
```

---

## Task 5: Runner skeleton — test first

**Files:**
- Create: `supabase/functions/_shared/agent/runner.test.ts`, `supabase/functions/_shared/agent/runner.ts`

The Phase-1 runner must:
1. Take a list of event IDs claimed by `agent-tick`.
2. Open one `agent_runs` row with `status='running'`.
3. Do nothing (no Claude call) — this is the no-op stub.
4. Mark the events `processed_at = now()` and the run `status='ok'`.

We test the orchestration with an in-memory client double — the SQL helpers themselves are tested via the integration test in Task 7.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test supabase/functions/_shared/agent/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the runner**

Create `supabase/functions/_shared/agent/runner.ts`:

```ts
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
```

- [ ] **Step 4: Run and watch it pass**

Run: `deno test supabase/functions/_shared/agent/runner.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts \
        supabase/functions/_shared/agent/runner.test.ts
git commit -m "feat(agent): no-op runner skeleton with claim/process/finish flow"
```

---

## Task 6: `agent-tick` edge function

**Files:**
- Create: `supabase/functions/agent-tick/index.ts`, `supabase/functions/agent-tick/deno.json`

- [ ] **Step 1: Copy the deno.json from an existing function**

```bash
cp supabase/functions/reminders-fire/deno.json supabase/functions/agent-tick/deno.json
```

(If `reminders-fire/deno.json` differs from what you expect, just write the minimal file:)
```json
{
  "imports": {}
}
```

- [ ] **Step 2: Write the entry point**

Create `supabase/functions/agent-tick/index.ts`:

```ts
// agent-tick - Phase 1 plumbing entry point.
//
// Invoked either by cron (with x-cron-secret) for every user with
// pending events, or by an authenticated user for their own row.
// Phase 1 is a no-op: runAgent() drains the queue without doing any
// Claude work. Phase 2 wires real tool execution into runner.ts.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runAgent } from '../_shared/agent/runner.ts';
import type { ClaimedEvent, RunnerDeps } from '../_shared/agent/runner.ts';
import type { AgentRunTrigger } from '../_shared/agent/types.ts';

const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function buildDeps(client: SupabaseClient, userId: string): RunnerDeps {
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
        .insert({
          user_id: uid,
          trigger,
          event_ids: eventIds,
          status: 'running',
        })
        .select('id')
        .single();
      if (error) throw error;
      return data!.id as string;
    },
    async finishRun(runId, status) {
      const { error } = await client
        .from('agent_runs')
        .update({ status, finished_at: new Date().toISOString() })
        .eq('id', runId);
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
  };
}

async function userIdsWithPendingEvents(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from('agent_events')
    .select('user_id')
    .is('processed_at', null);
  if (error) throw error;
  return Array.from(new Set((data ?? []).map((r: { user_id: string }) => r.user_id)));
}

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

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  const isCron = CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET;
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE);

  let userIds: string[];
  let trigger: AgentRunTrigger = 'tick';

  if (isCron) {
    userIds = await userIdsWithPendingEvents(serviceClient);
  } else {
    const uid = await authenticatedUserId(req);
    if (!uid) return new Response('unauthorized', { status: 401 });
    userIds = [uid];
  }

  const results = [];
  for (const uid of userIds) {
    try {
      const deps = buildDeps(serviceClient, uid);
      const r = await runAgent({ userId: uid, trigger, deps });
      results.push({ userId: uid, ...r });
    } catch (err) {
      console.error('[agent-tick] error for', uid, err);
      results.push({ userId: uid, error: String(err) });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { 'content-type': 'application/json' },
  });
});
```

- [ ] **Step 3: Add the claim-events RPC + advisory lock to the migration**

The runner calls `agent_claim_events` which must atomically: take a per-user advisory lock, return up to N unprocessed events for that user, and tag them with a fresh `batch_id` so a concurrent caller can't double-claim. Append to `supabase/migrations/20260511180000_agent_foundations.sql`:

```sql
-- Atomically claim a batch of unprocessed events for a user. Returns at most
-- p_limit rows. Uses pg_advisory_xact_lock keyed by user_id hash so two
-- concurrent runners can't both claim the same events.
create or replace function public.agent_claim_events(
  p_user_id uuid,
  p_limit int
) returns table (id bigint, kind text, payload jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  return query
  with claimed as (
    update public.agent_events e
    set batch_id = v_batch
    where e.id in (
      select id
      from public.agent_events
      where user_id = p_user_id
        and processed_at is null
        and batch_id is null
      order by id
      limit p_limit
      for update skip locked
    )
    returning e.id, e.kind, e.payload
  )
  select id, kind, payload from claimed;
end;
$$;

revoke all on function public.agent_claim_events(uuid, int) from public;
grant execute on function public.agent_claim_events(uuid, int) to service_role;
```

Re-apply: `supabase db reset --local`.

- [ ] **Step 4: Type-check the edge function**

Run: `deno check supabase/functions/agent-tick/index.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/agent-tick/ \
        supabase/migrations/20260511180000_agent_foundations.sql
git commit -m "feat(agent): agent-tick edge function + claim-events RPC"
```

---

## Task 7: Integration smoke — agent-tick end-to-end

**Files:**
- Modify: none — manual local-supabase smoke test.

- [ ] **Step 1: Boot a fresh local Supabase + serve the function**

```bash
supabase start
supabase functions serve agent-tick --env-file ./supabase/.env.local
```

(`.env.local` needs `CRON_SHARED_SECRET=test-secret`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — already standard in the repo.)

- [ ] **Step 2: Insert a test user and a synthetic event**

```bash
psql "$LOCAL_DB_URL" <<'SQL'
insert into auth.users (id, email)
  values ('00000000-0000-0000-0000-000000000001', 'phase1@test.local')
  on conflict do nothing;
insert into public.user_profiles (user_id, timezone)
  values ('00000000-0000-0000-0000-000000000001', 'UTC')
  on conflict do nothing;
insert into public.agent_events (user_id, kind, payload)
  values ('00000000-0000-0000-0000-000000000001', 'mail.new', '{"thread_id":"t1"}'::jsonb);
SQL
```

- [ ] **Step 3: Trigger the function as cron**

```bash
curl -sX POST http://localhost:54321/functions/v1/agent-tick \
  -H 'x-cron-secret: test-secret' | jq
```
Expected: JSON with `ok: true` and `results[].processed == 1`.

- [ ] **Step 4: Verify rows were written and event was processed**

```bash
psql "$LOCAL_DB_URL" -c "select status, processed_at is not null as marked from agent_runs r join agent_events e on e.id = any(r.event_ids) where r.user_id = '00000000-0000-0000-0000-000000000001';"
```
Expected: one row, `status='ok'`, `marked=true`.

- [ ] **Step 5: Trigger a second time and verify no new run is created**

```bash
curl -sX POST http://localhost:54321/functions/v1/agent-tick \
  -H 'x-cron-secret: test-secret' | jq
psql "$LOCAL_DB_URL" -c "select count(*) from agent_runs;"
```
Expected: still one run (no events to process → no run).

- [ ] **Step 6: Document the smoke procedure**

Add a one-line note to the function header comment in `supabase/functions/agent-tick/index.ts`:

```ts
// Smoke test: see docs/superpowers/plans/2026-05-11-autonomous-agent-phase-1-plumbing.md task 7.
```

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/agent-tick/index.ts
git commit -m "test(agent): document agent-tick local smoke procedure"
```

---

## Task 8: Client presence — test first

**Files:**
- Create: `src/lib/presence.ts`, `src/lib/__tests__/presence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/presence.test.ts
import { buildPresencePayload } from '../presence';

describe('buildPresencePayload', () => {
  it('returns last_active_at = now for foreground event', () => {
    const now = new Date('2026-05-11T18:00:00Z');
    expect(buildPresencePayload('foreground', 'user-1', now)).toEqual({
      user_id: 'user-1',
      last_active_at: '2026-05-11T18:00:00.000Z',
      last_app_open_at: '2026-05-11T18:00:00.000Z',
    });
  });

  it('returns last_active_at = now without bumping app_open for background', () => {
    const now = new Date('2026-05-11T18:01:00Z');
    expect(buildPresencePayload('background', 'user-1', now)).toEqual({
      user_id: 'user-1',
      last_active_at: '2026-05-11T18:01:00.000Z',
    });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- presence`
Expected: FAIL — "cannot find module presence".

- [ ] **Step 3: Implement `presence.ts`**

```ts
// src/lib/presence.ts
import { AppState, AppStateStatus } from 'react-native';
import { supabase } from './supabase';

export type PresenceEvent = 'foreground' | 'background';

export interface PresencePayload {
  user_id: string;
  last_active_at: string;
  last_app_open_at?: string;
}

export function buildPresencePayload(
  event: PresenceEvent,
  userId: string,
  now: Date = new Date(),
): PresencePayload {
  const iso = now.toISOString();
  if (event === 'foreground') {
    return { user_id: userId, last_active_at: iso, last_app_open_at: iso };
  }
  return { user_id: userId, last_active_at: iso };
}

export async function pingPresence(event: PresenceEvent, userId: string): Promise<void> {
  const payload = buildPresencePayload(event, userId);
  const { error } = await supabase
    .from('user_presence')
    .upsert(payload, { onConflict: 'user_id' });
  if (error) console.warn('[presence] upsert failed:', error.message);
}

let subscription: { remove: () => void } | null = null;

export function registerPresenceListener(getUserId: () => string | null): () => void {
  const handler = (state: AppStateStatus) => {
    const uid = getUserId();
    if (!uid) return;
    if (state === 'active') pingPresence('foreground', uid).catch(() => {});
    else if (state === 'background' || state === 'inactive') pingPresence('background', uid).catch(() => {});
  };
  const initial = getUserId();
  if (initial) pingPresence('foreground', initial).catch(() => {});
  subscription = AppState.addEventListener('change', handler);
  return () => {
    subscription?.remove();
    subscription = null;
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- presence`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/presence.ts src/lib/__tests__/presence.test.ts
git commit -m "feat(agent): client presence helpers + AppState listener"
```

---

## Task 9: Wire presence listener into App.tsx

**Files:**
- Modify: `App.tsx` — add import + effect that registers the listener while a user is signed in.

- [ ] **Step 1: Add the import**

In `App.tsx`, find the existing `import { syncUserProfile } from './src/lib/user-profile';` line and add directly below it:

```ts
import { registerPresenceListener } from './src/lib/presence';
```

- [ ] **Step 2: Register the listener inside the existing `useEffect` chain**

Find the body of `export default function App() { ... }`. After the `useAuth()` destructuring (`const { user, ... } = useAuth();`), append:

```ts
useEffect(() => {
  if (!user?.id) return;
  const unsubscribe = registerPresenceListener(() => user?.id ?? null);
  return unsubscribe;
}, [user?.id]);
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification on dev build**

Start Expo (`npx expo start --clear`), sign in, background and foreground the app, then:

```bash
psql "$REMOTE_DB_URL" -c "select user_id, last_active_at, last_app_open_at from user_presence where user_id = '<your-test-user-id>';"
```
Expected: row exists, `last_active_at` and `last_app_open_at` both within the last few seconds.

- [ ] **Step 5: Commit**

```bash
git add App.tsx
git commit -m "feat(agent): register presence listener on app boot"
```

---

## Task 10: `useAgentEnabled` hook — test first

**Files:**
- Create: `src/lib/agent-settings.ts`, `src/lib/__tests__/agent-settings.test.ts`

- [ ] **Step 1: Write the failing test (reducer-style: test the pure pieces)**

```ts
// src/lib/__tests__/agent-settings.test.ts
import { reduceAgentEnabled } from '../agent-settings';

describe('reduceAgentEnabled', () => {
  it('defaults to true when remote returns null', () => {
    expect(reduceAgentEnabled({ remote: null, optimistic: null })).toBe(true);
  });

  it('uses remote when set and no optimistic value', () => {
    expect(reduceAgentEnabled({ remote: false, optimistic: null })).toBe(false);
  });

  it('optimistic overrides remote', () => {
    expect(reduceAgentEnabled({ remote: false, optimistic: true })).toBe(true);
    expect(reduceAgentEnabled({ remote: true, optimistic: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- agent-settings`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `agent-settings.ts`**

```ts
// src/lib/agent-settings.ts
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface AgentEnabledState {
  remote: boolean | null;
  optimistic: boolean | null;
}

export function reduceAgentEnabled(state: AgentEnabledState): boolean {
  if (state.optimistic !== null) return state.optimistic;
  if (state.remote !== null) return state.remote;
  return true; // spec default: on
}

export function useAgentEnabled(userId: string | null | undefined): {
  enabled: boolean;
  loading: boolean;
  setEnabled: (next: boolean) => Promise<void>;
} {
  const [state, setState] = useState<AgentEnabledState>({ remote: null, optimistic: null });
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setLoading(false);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('agent_enabled')
        .eq('user_id', userId)
        .maybeSingle();
      if (cancelled) return;
      if (error) console.warn('[agent-settings] read failed:', error.message);
      setState((s) => ({ ...s, remote: data?.agent_enabled ?? true }));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const setEnabled = useCallback(async (next: boolean) => {
    if (!userId) return;
    setState((s) => ({ ...s, optimistic: next }));
    const { error } = await supabase
      .from('user_profiles')
      .update({ agent_enabled: next })
      .eq('user_id', userId);
    if (error) {
      console.warn('[agent-settings] write failed:', error.message);
      setState((s) => ({ ...s, optimistic: null }));
      return;
    }
    setState((s) => ({ remote: next, optimistic: null }));
  }, [userId]);

  return { enabled: reduceAgentEnabled(state), loading, setEnabled };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- agent-settings`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-settings.ts src/lib/__tests__/agent-settings.test.ts
git commit -m "feat(agent): useAgentEnabled hook with optimistic updates"
```

---

## Task 11: Zolva-handlinger Settings section

**Files:**
- Create: `src/components/ZolvaHandlingerSection.tsx`
- Modify: `src/screens/SettingsScreen.tsx` (import + render the new component).

- [ ] **Step 1: Write the new component**

Create `src/components/ZolvaHandlingerSection.tsx`:

```tsx
import React from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useAgentEnabled } from '../lib/agent-settings';
import { colors } from '../theme';

export function ZolvaHandlingerSection() {
  const { user } = useAuth();
  const { enabled, loading, setEnabled } = useAgentEnabled(user?.id);

  if (!user) return null;

  return (
    <View style={styles.section} accessibilityLabel="Zolva-handlinger">
      <Text style={styles.title}>Zolva-handlinger</Text>
      <Text style={styles.body}>
        Lad Zolva sortere indbakken og foreslå handlinger i baggrunden. Slå fra for at pause.
      </Text>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Tillad baggrundshandlinger</Text>
        <Switch
          value={enabled}
          onValueChange={(next) => { void setEnabled(next); }}
          disabled={loading}
          accessibilityLabel="agent-enabled-toggle"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingVertical: 16, gap: 8 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  rowLabel: { color: colors.ink, fontSize: 15 },
});
```

- [ ] **Step 2: Import + render in `SettingsScreen.tsx`**

In `src/screens/SettingsScreen.tsx`:
1. Add near the top with other component imports:
```ts
import { ZolvaHandlingerSection } from '../components/ZolvaHandlingerSection';
```
2. Find the main `<ScrollView>` (or container) that lists settings rows. Render `<ZolvaHandlingerSection />` directly above the existing "Memory" / privacy section so it sits prominently. The exact insertion point depends on local layout — pick the most natural slot near the top of the body.

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors. If `colors.muted` doesn't exist, fix per Step 1 note and re-run.

- [ ] **Step 4: Manual verification**

Start Expo, open Settings, toggle the switch twice, then:

```bash
psql "$REMOTE_DB_URL" -c "select agent_enabled from user_profiles where user_id = '<your-test-user-id>';"
```
Expected: column flips with each toggle.

- [ ] **Step 5: Commit**

```bash
git add src/components/ZolvaHandlingerSection.tsx src/screens/SettingsScreen.tsx
git commit -m "feat(agent): settings kill-switch for autonomous actions"
```

---

## Task 12: Today screen — agent empty-state card

**Files:**
- Create: `src/components/AgentEmptyState.tsx`
- Modify: `src/screens/TodayScreen.tsx`

- [ ] **Step 1: Build the empty-state component**

Create `src/components/AgentEmptyState.tsx`:

```tsx
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

export function AgentEmptyState() {
  return (
    <View style={styles.card} accessibilityLabel="agent-empty-state">
      <Text style={styles.title}>Zolva er klar</Text>
      <Text style={styles.body}>
        Når Zolva har handlet for dig eller har noget at foreslå, vises det her.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paperDeep,
    borderRadius: 14,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 12,
    gap: 4,
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 13, lineHeight: 18 },
});
```

- [ ] **Step 2: Render the card from TodayScreen**

In `src/screens/TodayScreen.tsx`:
1. Add import after the existing component imports near the top:
```ts
import { AgentEmptyState } from '../components/AgentEmptyState';
```
2. Inside the main scroll view, after the `<BriefBanner />` block (and before any large "no integrations" empty state), add:
```tsx
<AgentEmptyState />
```

Phase 1 always shows the empty state. Phase 2 swaps this for a feed component that queries `agent_actions` / `proposed_actions`.

- [ ] **Step 3: Type-check + manual verification**

```bash
npm run typecheck
npx expo start --clear
```
Open Today tab → confirm the card appears below the brief banner.

- [ ] **Step 4: Commit**

```bash
git add src/components/AgentEmptyState.tsx src/screens/TodayScreen.tsx
git commit -m "feat(agent): today feed empty state placeholder"
```

---

## Task 13: Deploy + cutover verification

**Files:**
- None — deployment of already-committed work.

- [ ] **Step 1: Push the branch and merge to main**

Phase-1 work lives on `worktree-autonomous-agent`. Per memory `project_build_from_main.md`, builds and OTA ship from main, so merge before deploying:

```bash
git push -u origin worktree-autonomous-agent
git checkout main
git merge --no-ff worktree-autonomous-agent -m "feat(agent): phase 1 plumbing"
git push origin main
```

- [ ] **Step 2: Apply migration to production**

```bash
supabase link --project-ref sjkhfkatmeqtsrysixop
supabase db push
```

Verify on the dashboard:
```bash
supabase migration list --linked | tail -5
```
Expected: `20260511180000_agent_foundations` listed as applied.

- [ ] **Step 3: Deploy `agent-tick`**

```bash
supabase functions deploy agent-tick --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

(`--no-verify-jwt` because cron callers pass `x-cron-secret` instead of a user JWT; per memory `project_supabase_asymmetric_jwt.md`.)

- [ ] **Step 4: Smoke-test against production**

```bash
curl -sX POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/agent-tick" \
  -H "x-cron-secret: $CRON_SHARED_SECRET" | jq
```
Expected: `{"ok":true,"results":[]}` (no users have pending events yet).

- [ ] **Step 5: Ship the client OTA**

```bash
eas update --branch production --message "feat(agent): phase 1 plumbing"
```

- [ ] **Step 6: End-to-end verification on a real device**

On your test device (memory `user_test_accounts.md` — primary `albertfeldt1@gmail.com`):
1. Pull the OTA update, sign in.
2. Open Settings → confirm the Zolva-handlinger section renders and toggles.
3. Open Today tab → confirm the empty state card appears.
4. Background/foreground the app once.
5. Query:
   ```bash
   psql "$REMOTE_DB_URL" -c "select user_id, last_active_at from user_presence where user_id = 'd02f1514-...';"
   ```
   Expected: row exists with a fresh timestamp.

- [ ] **Step 7: Final commit (release note)**

No code change — just verifies clean main:
```bash
git log -1 --oneline
git status
```
Expected: HEAD is on `main` matching the merge commit; working tree clean.

---

## Definition of done

- [ ] All migrations applied locally and on production (`supabase migration list --linked` shows `20260511180000_agent_foundations`).
- [ ] `agent-tick` deployed, responds 200 to cron + auth requests.
- [ ] Client OTA shipped; Settings shows toggle; Today shows empty-state card.
- [ ] `user_presence` is being upserted on real-device foreground/background transitions.
- [ ] All Deno + Jest tests added in this plan pass (`deno test supabase/functions/_shared/agent/` + `npm test -- agent-settings presence`).
- [ ] No regressions in existing test suites (`npm test`).

---

## What Phase 2 will plug in on top of this

Phase 2 (next plan) ships mail-triage auto-actions. It will:
- Add a `mail.new` event producer inside `poll-mail` (or its successor).
- Replace the no-op body of `runAgent` with a real Claude call that emits `mail.label` / `mail.archive` / `mail.summarize` / `mail.flag_important` tool calls.
- Add a `<TodayAgentFeed>` component that queries `agent_actions` (descending `executed_at`) and replaces `<AgentEmptyState>` when rows exist.
- Add Undo handling: tap → execute reverse-token via a new `agent-undo` edge function.

None of that should require changes to the tables or RPCs landed here.
