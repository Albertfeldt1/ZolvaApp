# Commitment Tracking — Implementation Plan (Slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the engine for proactive commitment tracking — a durable `agent_commitments` table, an `agent-commitments` edge function that extracts the user's `you_owe` promises from sent mail and sends conservative deterministic push nudges before they come due — end-to-end and smoke-testable on a real mailbox.

**Architecture:** Mirrors the `agent-reflect` calendar-prep feature. A new edge function on a cron sweep does two phases per `agent_enabled` user: (1) **extract** — pre-fetch recent sent threads, run a one-tool Claude loop that calls `commitment_record`, upsert rows; (2) **reconcile + nudge** — expire stale rows, select due rows, fire one templated `nudge.push` per loop via the existing record-then-send path. All persistence side-effects go through `RunnerDeps`, mirroring how `nudge.push`/`fireNudge` works, so the Claude-facing dispatcher stays Supabase-free and the pure logic is unit-tested without network.

**Tech Stack:** Deno edge functions (Supabase), TypeScript, `https://deno.land/std` test runner (`deno test`), Supabase Postgres + pg_cron, Anthropic Messages API (existing `callClaudeTurn`).

**Scope:** Slice 1 only — `you_owe` extracted from **sent** mail, expire-only reconciliation, templated nudges. Deferred to later plans: `owed_to_you` / stale-thread detection (Slice 2), thread-read reconciliation + in-app "Open loops" list (Slice 3). See spec `docs/superpowers/specs/2026-05-31-commitment-tracking-design.md`.

**Reference conventions (read before starting):**
- New-tool checklist: `project_autonomous_agent_phase4a.md` (memory) — every new ActionType touches types.ts, prompt.ts, runner.ts SUPPORTED/NON_THREAD sets, dispatch.ts.
- The `nudge.push` record-then-send pattern: `runner.ts:456-475` (`fireNudge`) and `dispatch.ts:101-113`.
- The reflect sweep pattern this clones: `supabase/functions/agent-reflect/index.ts`.
- pg_cron templates are NOT auto-applied (`project_cron_template_apply.md`) — verify the `cron.job` row exists at the end.
- Server commits + deploy ship FIRST, before any client work (`project_client_server_pr_split.md`). This whole slice is server-only.

---

## File Structure

- **Create** `supabase/migrations/<ts>_agent_commitments.sql` — table + `user_profiles.commitments_scanned_at` watermark column.
- **Create** `supabase/functions/_shared/agent/commitments.ts` — pure logic: types, `resolveDue`, `selectDue`, `applyReconcile`, `buildCommitmentNudge`. The tested core.
- **Create** `supabase/functions/_shared/agent/commitments.test.ts` — unit tests for the above.
- **Modify** `supabase/functions/_shared/agent/types.ts` — add `commitment.record` ActionType, `commitments.scan`/`commitments.nudge` triggers, policy-table entries.
- **Modify** `supabase/functions/_shared/agent/prompt.ts` — `commitment_record` tool def + `TOOL_NAME_TO_ACTION` entry + `COMMITMENT_SCAN_TOOLS` + `buildCommitmentScanPrompt`.
- **Modify** `supabase/functions/_shared/agent/tools/dispatch.ts` — `commitment.record` payload-shaping branch.
- **Modify** `supabase/functions/_shared/agent/runner.ts` — `runCommitmentScan` (one-tool Claude loop) + `recordCommitment` dep on `RunnerDeps` + add action to `SUPPORTED_ACTIONS`/`NON_THREAD_ACTIONS`.
- **Modify** `supabase/functions/_shared/agent/build-deps.ts` — implement `recordCommitment`; add candidate/commitment read+write helpers used by the edge fn.
- **Create** `supabase/functions/agent-commitments/index.ts` — the sweep orchestration.
- **Create** `supabase/schedule-agent-commitments.sql.template` — cron registration (manual apply).

---

## Task 1: Migration — `agent_commitments` table + watermark

**Files:**
- Create: `supabase/migrations/<timestamp>_agent_commitments.sql`

- [ ] **Step 1: Write the migration**

Generate a timestamp prefix matching the repo's existing migration naming (look at `ls supabase/migrations | tail -3` for the format). Content:

```sql
-- agent_commitments: durable "open loops" the agent tracks per user.
create table if not exists public.agent_commitments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  direction       text not null check (direction in ('you_owe','owed_to_you')),
  counterparty    text not null default '',
  summary         text not null,
  due_at          timestamptz,
  due_inferred    boolean not null default false,
  thread_id       text not null,
  provider        text not null check (provider in ('google','microsoft')),
  source_excerpt  text not null default '',
  last_message_at timestamptz,
  status          text not null default 'open'
                    check (status in ('open','nudged','resolved','dismissed','expired')),
  created_at      timestamptz not null default now(),
  nudged_at       timestamptz,
  resolved_at     timestamptz,
  unique (user_id, thread_id, direction)
);

create index if not exists agent_commitments_due_idx
  on public.agent_commitments (user_id, status, due_at);

alter table public.agent_commitments enable row level security;

-- Owner can read their own commitments (in-app list, Slice 3). Writes are
-- service-role only (the edge fn), matching the other agent_* tables.
create policy agent_commitments_select_own on public.agent_commitments
  for select using (auth.uid() = user_id);

-- Per-user extraction watermark: extraction only re-runs when this is stale.
alter table public.user_profiles
  add column if not exists commitments_scanned_at timestamptz;
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `apply_migration` (project ref `sjkhfkatmeqtsrysixop`), or `supabase db push` if the local CLI is linked. Use the file's name as the migration name.

- [ ] **Step 3: Verify the table exists**

Run (MCP `execute_sql` or `supabase`): `select column_name, data_type from information_schema.columns where table_name = 'agent_commitments' order by ordinal_position;`
Expected: 14 columns matching the DDL. Also confirm `user_profiles.commitments_scanned_at` exists.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations
git commit -m "feat(agent): add agent_commitments table + scan watermark"
```

---

## Task 2: Pure logic — `commitments.ts` types + `resolveDue`

**Files:**
- Create: `supabase/functions/_shared/agent/commitments.ts`
- Test: `supabase/functions/_shared/agent/commitments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveDue } from './commitments.ts';

Deno.test('resolveDue keeps an explicit due date and marks it not inferred', () => {
  const r = resolveDue('you_owe', '2026-06-05T09:00:00Z', '2026-06-01T10:00:00Z');
  assertEquals(r, { dueAt: '2026-06-05T09:00:00Z', inferred: false });
});

Deno.test('resolveDue infers +2 days for a you_owe promise from the anchor', () => {
  const r = resolveDue('you_owe', null, '2026-06-01T10:00:00Z');
  assertEquals(r, { dueAt: '2026-06-03T10:00:00.000Z', inferred: true });
});

Deno.test('resolveDue infers +3 days for owed_to_you from the anchor', () => {
  const r = resolveDue('owed_to_you', null, '2026-06-01T10:00:00Z');
  assertEquals(r, { dueAt: '2026-06-04T10:00:00.000Z', inferred: true });
});

Deno.test('resolveDue with no explicit date and no anchor yields null', () => {
  const r = resolveDue('you_owe', null, null);
  assertEquals(r, { dueAt: null, inferred: false });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `deno test supabase/functions/_shared/agent/commitments.test.ts --allow-none 2>&1 | head -20` (use the repo's standard deno test invocation if different — check `deno.json`/`package.json` scripts).
Expected: FAIL — `resolveDue` not exported / module missing.

- [ ] **Step 3: Write the types + `resolveDue`**

```ts
// supabase/functions/_shared/agent/commitments.ts
//
// Pure logic for commitment tracking: due-date inference, due-selection,
// reconciliation transitions, and nudge templating. No network, no Supabase —
// every function is a deterministic transform so the bulk of confidence lives
// in unit tests (this codebase's hard lesson: prove the layer, don't assume it).

export type CommitmentDirection = 'you_owe' | 'owed_to_you';
export type CommitmentStatus = 'open' | 'nudged' | 'resolved' | 'dismissed' | 'expired';

// What the extraction Claude pass produces (one per commitment_record call),
// before persistence fills in id/status/timestamps.
export interface ExtractedCommitment {
  direction: CommitmentDirection;
  counterparty: string;
  summary: string;
  due_at: string | null;        // explicit ISO if the mail named a deadline
  thread_id: string;
  provider: 'google' | 'microsoft';
  source_excerpt: string;
  last_message_at: string | null;
}

// A persisted row, as read back for reconcile/nudge.
export interface CommitmentRow {
  id: string;
  user_id: string;
  direction: CommitmentDirection;
  counterparty: string;
  summary: string;
  due_at: string | null;
  due_inferred: boolean;
  thread_id: string;
  provider: 'google' | 'microsoft';
  source_excerpt: string;
  last_message_at: string | null;
  status: CommitmentStatus;
  created_at: string;
  nudged_at: string | null;
  resolved_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Fill a soft due date when the mail named none. Calendar days (not business
// days) in v1 — deterministic and testable; business-day refinement is a
// future tweak noted in the spec.
export function resolveDue(
  direction: CommitmentDirection,
  explicitDueAt: string | null,
  anchorIso: string | null,
): { dueAt: string | null; inferred: boolean } {
  if (explicitDueAt) return { dueAt: explicitDueAt, inferred: false };
  if (!anchorIso) return { dueAt: null, inferred: false };
  const anchor = new Date(anchorIso).getTime();
  if (Number.isNaN(anchor)) return { dueAt: null, inferred: false };
  const offset = direction === 'you_owe' ? 2 * DAY_MS : 3 * DAY_MS;
  return { dueAt: new Date(anchor + offset).toISOString(), inferred: true };
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `deno test supabase/functions/_shared/agent/commitments.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/commitments.ts supabase/functions/_shared/agent/commitments.test.ts
git commit -m "feat(agent): commitment types + resolveDue inference"
```

---

## Task 3: Pure logic — `selectDue`

**Files:**
- Modify: `supabase/functions/_shared/agent/commitments.ts`
- Test: `supabase/functions/_shared/agent/commitments.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```ts
import { selectDue } from './commitments.ts';

function row(over: Partial<CommitmentRow>): CommitmentRow {
  return {
    id: 'c1', user_id: 'u1', direction: 'you_owe', counterparty: 'Allan',
    summary: 'Send Q3-decket', due_at: null, due_inferred: false,
    thread_id: 't1', provider: 'google', source_excerpt: '', last_message_at: null,
    status: 'open', created_at: '2026-06-01T08:00:00Z', nudged_at: null, resolved_at: null,
    ...over,
  };
}
import type { CommitmentRow } from './commitments.ts';

Deno.test('selectDue picks a you_owe due within 24h not yet nudged today', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const r = row({ direction: 'you_owe', due_at: '2026-06-03T20:00:00Z' });
  assertEquals(selectDue([r], now).map((c) => c.id), ['c1']);
});

Deno.test('selectDue skips a you_owe due more than 24h out', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const r = row({ direction: 'you_owe', due_at: '2026-06-05T09:00:00Z' });
  assertEquals(selectDue([r], now), []);
});

Deno.test('selectDue skips a you_owe already nudged today (Copenhagen day)', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const r = row({ direction: 'you_owe', due_at: '2026-06-03T20:00:00Z', nudged_at: '2026-06-03T06:00:00Z' });
  assertEquals(selectDue([r], now), []);
});

Deno.test('selectDue picks an owed_to_you silent >3d and never nudged', () => {
  const now = new Date('2026-06-05T09:00:00Z');
  const r = row({ direction: 'owed_to_you', last_message_at: '2026-06-01T09:00:00Z', nudged_at: null });
  assertEquals(selectDue([r], now).map((c) => c.id), ['c1']);
});

Deno.test('selectDue nudges owed_to_you only once (nudged_at set => skip)', () => {
  const now = new Date('2026-06-05T09:00:00Z');
  const r = row({ direction: 'owed_to_you', last_message_at: '2026-06-01T09:00:00Z', nudged_at: '2026-06-04T09:00:00Z' });
  assertEquals(selectDue([r], now), []);
});

Deno.test('selectDue ignores non-open rows', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const r = row({ status: 'resolved', due_at: '2026-06-03T20:00:00Z' });
  assertEquals(selectDue([r], now), []);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test supabase/functions/_shared/agent/commitments.test.ts`
Expected: FAIL — `selectDue` not exported.

- [ ] **Step 3: Implement `selectDue`**

Append to `commitments.ts`:

```ts
// Europe/Copenhagen calendar day (YYYY-MM-DD) — matches the nudge.push idem
// day component so "already nudged today" lines up with local midnight.
function copenhagenDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const DUE_LEAD_MS = 24 * 60 * 60 * 1000;   // you_owe: nudge within 24h of due
const SILENCE_MS = 3 * DAY_MS;             // owed_to_you: 3 days of silence

export function selectDue(rows: CommitmentRow[], now: Date): CommitmentRow[] {
  const nowMs = now.getTime();
  const today = copenhagenDay(now);
  return rows.filter((r) => {
    if (r.status !== 'open') return false;
    if (r.direction === 'you_owe') {
      if (!r.due_at) return false;
      const due = new Date(r.due_at).getTime();
      if (Number.isNaN(due) || due > nowMs + DUE_LEAD_MS) return false;
      // Once per day until resolved.
      return !(r.nudged_at && copenhagenDay(new Date(r.nudged_at)) === today);
    }
    // owed_to_you: silent past the threshold, nudged at most once ever.
    if (r.nudged_at) return false;
    if (!r.last_message_at) return false;
    const last = new Date(r.last_message_at).getTime();
    return !Number.isNaN(last) && last <= nowMs - SILENCE_MS;
  });
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `deno test supabase/functions/_shared/agent/commitments.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/commitments.ts supabase/functions/_shared/agent/commitments.test.ts
git commit -m "feat(agent): selectDue predicate for commitment nudging"
```

---

## Task 4: Pure logic — `applyReconcile`

**Files:**
- Modify: `supabase/functions/_shared/agent/commitments.ts`
- Test: `supabase/functions/_shared/agent/commitments.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
import { applyReconcile } from './commitments.ts';

Deno.test('applyReconcile expires a you_owe past due_at + 7d with no movement', () => {
  const now = new Date('2026-06-15T09:00:00Z');
  const r = row({ direction: 'you_owe', due_at: '2026-06-03T09:00:00Z' });
  // No thread movement signal available in slice 1 (expire-only).
  assertEquals(applyReconcile(r, { lastMessageAt: null, lastDirection: null }, now),
    { status: 'expired' });
});

Deno.test('applyReconcile resolves a you_owe when the user sent a newer message', () => {
  const now = new Date('2026-06-04T09:00:00Z');
  const r = row({ direction: 'you_owe', created_at: '2026-06-01T08:00:00Z', due_at: '2026-06-05T09:00:00Z' });
  assertEquals(
    applyReconcile(r, { lastMessageAt: '2026-06-03T12:00:00Z', lastDirection: 'outbound' }, now),
    { status: 'resolved', resolved_at: now.toISOString() },
  );
});

Deno.test('applyReconcile resolves an owed_to_you when an inbound reply arrives', () => {
  const now = new Date('2026-06-04T09:00:00Z');
  const r = row({ direction: 'owed_to_you', last_message_at: '2026-06-01T09:00:00Z' });
  assertEquals(
    applyReconcile(r, { lastMessageAt: '2026-06-03T10:00:00Z', lastDirection: 'inbound' }, now),
    { status: 'resolved', resolved_at: now.toISOString() },
  );
});

Deno.test('applyReconcile returns null when nothing changed', () => {
  const now = new Date('2026-06-04T09:00:00Z');
  const r = row({ direction: 'you_owe', created_at: '2026-06-01T08:00:00Z', due_at: '2026-06-10T09:00:00Z' });
  assertEquals(applyReconcile(r, { lastMessageAt: null, lastDirection: null }, now), null);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test supabase/functions/_shared/agent/commitments.test.ts`
Expected: FAIL — `applyReconcile` not exported.

- [ ] **Step 3: Implement `applyReconcile`**

Append:

```ts
const EXPIRE_GRACE_MS = 7 * DAY_MS;

export interface ThreadState {
  // Newest message timestamp in the source thread (null when not fetched).
  lastMessageAt: string | null;
  // Who sent that newest message relative to the user.
  lastDirection: 'inbound' | 'outbound' | null;
}

// Decide the next status for an open commitment given current thread state.
// Returns the fields to update, or null when nothing changes. Order matters:
// resolution (the loop is closed) wins over expiry (the loop went stale).
export function applyReconcile(
  row: CommitmentRow,
  thread: ThreadState,
  now: Date,
): { status: 'resolved'; resolved_at: string } | { status: 'expired' } | null {
  if (row.status !== 'open') return null;
  const nowIso = now.toISOString();

  if (thread.lastMessageAt && thread.lastDirection) {
    const last = new Date(thread.lastMessageAt).getTime();
    if (row.direction === 'owed_to_you' && thread.lastDirection === 'inbound') {
      const prev = row.last_message_at ? new Date(row.last_message_at).getTime() : 0;
      if (last > prev) return { status: 'resolved', resolved_at: nowIso };
    }
    if (row.direction === 'you_owe' && thread.lastDirection === 'outbound') {
      const created = new Date(row.created_at).getTime();
      if (last > created) return { status: 'resolved', resolved_at: nowIso };
    }
  }

  if (row.due_at) {
    const due = new Date(row.due_at).getTime();
    if (!Number.isNaN(due) && now.getTime() > due + EXPIRE_GRACE_MS) {
      return { status: 'expired' };
    }
  }
  return null;
}
```

> Note for the implementer: in Slice 1 the edge fn passes `{ lastMessageAt: null, lastDirection: null }` (expire-only — no per-thread reads yet). The resolved-by-movement branches are exercised by tests now and wired to real thread reads in Slice 3. They're implemented now because the logic is pure and cheap to verify.

- [ ] **Step 4: Run to confirm pass**

Run: `deno test supabase/functions/_shared/agent/commitments.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/commitments.ts supabase/functions/_shared/agent/commitments.test.ts
git commit -m "feat(agent): applyReconcile commitment state transitions"
```

---

## Task 5: Pure logic — `buildCommitmentNudge`

**Files:**
- Modify: `supabase/functions/_shared/agent/commitments.ts`
- Test: `supabase/functions/_shared/agent/commitments.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
import { buildCommitmentNudge } from './commitments.ts';

Deno.test('buildCommitmentNudge for you_owe names the counterparty and summary', () => {
  const n = buildCommitmentNudge(row({ direction: 'you_owe', counterparty: 'Allan', summary: 'send Q3-decket' }));
  assertEquals(n.action_kind, 'commitment');
  assertEquals(n.target_id, 't1');
  assertEquals(n.body.includes('Allan'), true);
  assertEquals(n.body.includes('send Q3-decket'), true);
});

Deno.test('buildCommitmentNudge for owed_to_you phrases it as waiting', () => {
  const n = buildCommitmentNudge(row({ direction: 'owed_to_you', counterparty: 'Mette', summary: 'svar om mødet' }));
  assertEquals(n.body.toLowerCase().includes('venter'), true);
  assertEquals(n.body.includes('Mette'), true);
});

Deno.test('buildCommitmentNudge clamps body to 140 chars', () => {
  const n = buildCommitmentNudge(row({ summary: 'x'.repeat(300) }));
  assertEquals(n.body.length <= 140, true);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test supabase/functions/_shared/agent/commitments.test.ts`
Expected: FAIL — `buildCommitmentNudge` not exported.

- [ ] **Step 3: Implement `buildCommitmentNudge`**

Append:

```ts
export interface CommitmentNudge {
  action_kind: string;   // always 'commitment' — the rate-limit category
  target_id: string;     // thread_id — one nudge per loop per day
  title: string;         // Danish, <= 40 chars
  body: string;          // Danish, <= 140 chars
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function buildCommitmentNudge(row: CommitmentRow): CommitmentNudge {
  const who = row.counterparty || 'nogen';
  const title = row.direction === 'you_owe' ? 'Du skylder et svar' : 'Du venter på svar';
  const body = row.direction === 'you_owe'
    ? `Du lovede ${who}: ${row.summary}`
    : `Du venter stadig på svar fra ${who}: ${row.summary}`;
  return {
    action_kind: 'commitment',
    target_id: row.thread_id,
    title: clamp(title, 40),
    body: clamp(body, 140),
  };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `deno test supabase/functions/_shared/agent/commitments.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/commitments.ts supabase/functions/_shared/agent/commitments.test.ts
git commit -m "feat(agent): buildCommitmentNudge templated push copy"
```

---

## Task 6: Wire the new ActionType + trigger into `types.ts`

**Files:**
- Modify: `supabase/functions/_shared/agent/types.ts`

- [ ] **Step 1: Add the ActionType**

In the `ActionType` union (after `'standing_task.create'`), add `'commitment.record'`:

```ts
  | 'standing_task.create'
  | 'commitment.record';
```

- [ ] **Step 2: Add the run triggers**

In the `AgentRunTrigger` union add the two commitment triggers:

```ts
export type AgentRunTrigger =
  | 'tick'
  | 'reflect.morning'
  | 'reflect.midday'
  | 'reflect.evening'
  | 'reflect.sweep'
  | 'commitments.scan'
  | 'commitments.nudge';
```

- [ ] **Step 3: Add policy-table entries (BOTH maps — they must stay in sync)**

Add to `DEFAULT_POLICY` and `ACTION_DEFAULT_MODE` the same entry. `commitment.record` writes only to our own table — treat as `auto`:

```ts
  'standing_task.create': 'propose',
  'commitment.record': 'auto',
```

(Add the identical line to both `DEFAULT_POLICY` and `ACTION_DEFAULT_MODE`.)

- [ ] **Step 4: Typecheck**

Run: `deno check supabase/functions/_shared/agent/types.ts`
Expected: no errors. (TS will now flag any `Record<ActionType, …>` map missing the new key — none other than the two policy maps reference it yet.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/types.ts
git commit -m "feat(agent): register commitment.record action + commitment triggers"
```

---

## Task 7: `commitment_record` tool def + scan prompt in `prompt.ts`

**Files:**
- Modify: `supabase/functions/_shared/agent/prompt.ts`
- Test: `supabase/functions/_shared/agent/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `prompt.test.ts`:

```ts
import { actionTypeFromToolName, COMMITMENT_SCAN_TOOLS, buildCommitmentScanPrompt } from './prompt.ts';

Deno.test('commitment_record maps to commitment.record action', () => {
  assertEquals(actionTypeFromToolName('commitment_record'), 'commitment.record');
});

Deno.test('COMMITMENT_SCAN_TOOLS offers only commitment_record', () => {
  assertEquals(COMMITMENT_SCAN_TOOLS.map((t) => t.name), ['commitment_record']);
});

Deno.test('buildCommitmentScanPrompt lists candidate threads', () => {
  const { system, messages } = buildCommitmentScanPrompt({
    candidates: [{
      thread_id: 't1', provider: 'google', counterparty: 'Allan',
      subject: 'Q3', latest_text: 'Jeg sender decket på fredag', latest_from: 'user',
      latest_at: '2026-06-01T10:00:00Z',
    }],
    nowIso: '2026-06-01T12:00:00Z',
  });
  assertEquals(system.length, 1);
  assertEquals(String(messages[0].content).includes('t1'), true);
});
```

(Reuse the existing `assertEquals` import at the top of `prompt.test.ts`; don't duplicate it.)

- [ ] **Step 2: Run to confirm failure**

Run: `deno test supabase/functions/_shared/agent/prompt.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement the tool, map entry, and prompt**

In `prompt.ts`, add to `TOOL_NAME_TO_ACTION`:

```ts
  nudge_push: 'nudge.push',
  commitment_record: 'commitment.record',
```

After the `REFLECT_TOOLS` definition add:

```ts
const COMMITMENT_RECORD_TOOL = {
  name: 'commitment_record',
  description:
    'Record ONE open commitment found in the thread shown. Use only for a real, actionable obligation with a clear owner — a promise the user made ("jeg sender X på fredag") for direction="you_owe". Skip greetings, FYIs, newsletters, and anything vague. Provide due_at (UTC ISO-8601, ends with Z) only if the text names a concrete deadline; otherwise omit it and it will be inferred. summary is a short Danish phrase of the obligation (≤ 120 chars). source_excerpt is the exact sentence that shows the commitment.',
  input_schema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['you_owe', 'owed_to_you'] },
      counterparty: { type: 'string', description: 'name or email of the other party' },
      summary: { type: 'string', maxLength: 120 },
      due_at: { type: 'string', description: 'UTC ISO-8601 ending in Z, only if explicitly stated' },
      thread_id: { type: 'string' },
      provider: { type: 'string', enum: ['google', 'microsoft'] },
      source_excerpt: { type: 'string', maxLength: 300 },
    },
    required: ['direction', 'counterparty', 'summary', 'thread_id', 'provider', 'source_excerpt'],
  },
} as const;

export const COMMITMENT_SCAN_TOOLS = [COMMITMENT_RECORD_TOOL] as const;

const COMMITMENT_SCAN_SYSTEM_PROMPT = `Du er Zolva. Du gennemgår brugerens SENDTE mails og finder forpligtelser brugeren selv har lovet — ting brugeren skal følge op på.

For hver tråd i brugerens besked:
- Afgør om brugeren har givet et konkret løfte eller en aftale ("jeg sender X på fredag", "jeg vender tilbage mandag", "jeg ordner det inden ugen er omme").
- Hvis ja, kald commitment_record med direction="you_owe", en kort dansk summary, modparten (counterparty), thread_id, provider og det præcise citat (source_excerpt). Angiv kun due_at hvis teksten nævner en konkret dato/deadline — ellers udelad den.
- Ignorer høflighedsfraser, nyhedsbreve, automatiske beskeder og alt vagt. I tvivl: spring tråden over.

Du må kun bruge thread_id'er fra listen i beskeden. Kald commitment_record én gang pr. reel forpligtelse. Svar kort på dansk når du er færdig.`;

export interface ScanCandidate {
  thread_id: string;
  provider: 'google' | 'microsoft';
  counterparty: string;
  subject: string;
  latest_text: string;
  latest_from: 'user' | 'them';
  latest_at: string;
}

export function buildCommitmentScanPrompt(input: { candidates: ScanCandidate[]; nowIso?: string }): BuildMailTriagePromptResult {
  const system: ClaudeSystemBlock[] = [
    { type: 'text', text: COMMITMENT_SCAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  const dateLine = input.nowIso
    ? `Dags dato: ${formatDanishDate(input.nowIso)} (tidszone Europe/Copenhagen).`
    : '';
  const lines = input.candidates.map((c) =>
    `- thread_id=${c.thread_id} | provider=${c.provider} | modpart=${c.counterparty} | emne=${c.subject}` +
    ` | sendt=${c.latest_at} | tekst=${c.latest_text.slice(0, 500)}`,
  );
  const body = [...(dateLine ? [dateLine, ''] : []), 'Gennemgå disse sendte tråde:', '', ...lines].join('\n');
  return { system, messages: [{ role: 'user', content: body }] };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `deno test supabase/functions/_shared/agent/prompt.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/prompt.ts supabase/functions/_shared/agent/prompt.test.ts
git commit -m "feat(agent): commitment_record tool + scan prompt"
```

---

## Task 8: `commitment.record` payload-shaping in `dispatch.ts`

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts`
- Test: `supabase/functions/_shared/agent/tools/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `dispatch.test.ts` (reuse existing imports of `executeTool`):

```ts
Deno.test('commitment.record shapes its payload without touching providers', async () => {
  const res = await executeTool('commitment.record', {
    direction: 'you_owe', counterparty: 'Allan', summary: 'send decket',
    thread_id: 't1', provider: 'google', source_excerpt: 'jeg sender decket på fredag',
    due_at: '2026-06-05T09:00:00Z',
  }, {} as never);
  assertEquals(res.mode, 'executed');
  assertEquals(res.recordPayload.direction, 'you_owe');
  assertEquals(res.recordPayload.thread_id, 't1');
  assertEquals(res.recordPayload.due_at, '2026-06-05T09:00:00Z');
});

Deno.test('commitment.record omits due_at when not provided', async () => {
  const res = await executeTool('commitment.record', {
    direction: 'you_owe', counterparty: 'Allan', summary: 's',
    thread_id: 't1', provider: 'google', source_excerpt: 'x',
  }, {} as never);
  assertEquals('due_at' in res.recordPayload, false);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test supabase/functions/_shared/agent/tools/dispatch.test.ts`
Expected: FAIL — `executeTool: unsupported action type commitment.record`.

- [ ] **Step 3: Implement the branch**

In `dispatch.ts`, right after the `nudge.push` early-return block (before `const provider = mustProvider(payload);`), add:

```ts
  // commitment.record writes to our own agent_commitments table — no provider
  // API call. Like nudge.push, the dispatcher only validates + shapes; the
  // runner performs the upsert via deps.recordCommitment. Handled before
  // mustProvider so the (present) provider field is validated by mustString,
  // not the generic provider guard.
  if (action === 'commitment.record') {
    const direction = mustString(payload, 'direction');
    if (direction !== 'you_owe' && direction !== 'owed_to_you') {
      throw new Error(`commitment.record invalid direction ${direction}`);
    }
    const rec: Record<string, unknown> = {
      direction,
      counterparty: mustString(payload, 'counterparty'),
      summary: mustString(payload, 'summary'),
      thread_id: mustString(payload, 'thread_id'),
      provider: mustString(payload, 'provider'),
      source_excerpt: mustString(payload, 'source_excerpt'),
    };
    if (typeof payload.due_at === 'string' && payload.due_at) rec.due_at = payload.due_at;
    return { mode: 'executed', reversible: false, reverseToken: null, recordPayload: rec };
  }
```

- [ ] **Step 4: Run to confirm pass**

Run: `deno test supabase/functions/_shared/agent/tools/dispatch.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/dispatch.ts supabase/functions/_shared/agent/tools/dispatch.test.ts
git commit -m "feat(agent): dispatch commitment.record payload shaping"
```

---

## Task 9: `runCommitmentScan` + `recordCommitment` dep in `runner.ts`

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts`
- Test: `supabase/functions/_shared/agent/runner.test.ts`

- [ ] **Step 1: Write the failing test**

This is a one-tool Claude loop. Append to `runner.test.ts`, following the existing pattern there for stubbing `RunnerDeps` (copy an existing deps factory in that file and extend it). The test asserts a `commitment_record` tool_use drives `recordCommitment`:

```ts
import { runCommitmentScan } from './runner.ts';

Deno.test('runCommitmentScan records each commitment_record tool call', async () => {
  const recorded: Array<Record<string, unknown>> = [];
  let turn = 0;
  const deps = makeBaseDeps({                      // reuse the file's helper; see note below
    checkBudget: () => Promise.resolve({ exceeded: false }),
    openRun: () => Promise.resolve('run-1'),
    incrementBudget: () => Promise.resolve(),
    finishRun: () => Promise.resolve(),
    recordCommitment: (_uid, _run, c) => { recorded.push(c); return Promise.resolve('inserted'); },
    callClaudeTurn: () => {
      turn++;
      if (turn === 1) {
        return Promise.resolve({
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 'tu1', name: 'commitment_record', input: {
            direction: 'you_owe', counterparty: 'Allan', summary: 'send decket',
            thread_id: 't1', provider: 'google', source_excerpt: 'x',
          } }],
        });
      }
      return Promise.resolve({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'færdig' }] });
    },
  });

  const res = await runCommitmentScan({
    userId: 'u1',
    candidates: [{ thread_id: 't1', provider: 'google', counterparty: 'Allan', subject: 'Q3', latest_text: 'jeg sender decket på fredag', latest_from: 'user', latest_at: '2026-06-01T10:00:00Z' }],
    deps,
  });

  assertEquals(res.status, 'ok');
  assertEquals(recorded.length, 1);
  assertEquals(recorded[0].thread_id, 't1');
});
```

> Implementer note: `runner.test.ts` already constructs full `RunnerDeps` stubs for the mail/reflect tests. Extract or reuse that factory as `makeBaseDeps` (a no-op default for every dep) if one doesn't already exist, so this test only overrides the few deps it cares about. Add a no-op `recordCommitment: () => Promise.resolve('inserted')` to that base factory.

- [ ] **Step 2: Run to confirm failure**

Run: `deno test supabase/functions/_shared/agent/runner.test.ts`
Expected: FAIL — `runCommitmentScan` / `recordCommitment` missing.

- [ ] **Step 3: Implement**

In `runner.ts`:

(a) Add to the `RunnerDeps` interface:

```ts
  // Commitment tracking: upsert one extracted commitment into agent_commitments
  // on the (user_id, thread_id, direction) dedup key. Returns whether the row
  // was newly inserted or an existing one updated (for trace/metrics only).
  recordCommitment: (
    userId: string,
    runId: string,
    commitment: Record<string, unknown>,
  ) => Promise<'inserted' | 'updated'>;
```

(b) Add `commitment.record` to `SUPPORTED_ACTIONS` and `NON_THREAD_ACTIONS`:

```ts
  'nudge.push',
  'commitment.record',
]);
```
(in both sets — `commitment.record` carries `thread_id` as data, not as a read target, so it must skip the thread hallucination-guard.)

(c) Import `buildCommitmentScanPrompt`, `COMMITMENT_SCAN_TOOLS`, and the `ScanCandidate` type from `./prompt.ts`, plus `resolveDue` from `./commitments.ts`.

(d) Add the scan function (a focused Claude loop — it does NOT reuse `executeRun`, which is coupled to claimed `agent_events`; scan candidates are not events):

```ts
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
          // Fill the inferred due date here (anchor = the sent message time when
          // available, else now) before persisting.
          const anchor = typeof tu.input?.latest_at === 'string' ? tu.input.latest_at as string : new Date().toISOString();
          const { dueAt, inferred } = resolveDue(
            exec.recordPayload.direction as 'you_owe' | 'owed_to_you',
            typeof exec.recordPayload.due_at === 'string' ? exec.recordPayload.due_at : null,
            anchor,
          );
          const outcome = await deps.recordCommitment(userId, runId, {
            ...exec.recordPayload,
            due_at: dueAt,
            due_inferred: inferred,
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
```

> Note: `latest_at` is on `ScanCandidate`, not on the tool input. The anchor lookup above reads `tu.input.latest_at` defensively but Claude won't supply it — so in practice the anchor falls back to `now`, which is correct for a freshly-sent promise. (Slice 3 can thread the candidate's real `latest_at` through if precision matters.)

- [ ] **Step 4: Run to confirm pass**

Run: `deno test supabase/functions/_shared/agent/runner.test.ts`
Expected: all passed (existing tests still green — the new dep has a no-op default in the base factory).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts supabase/functions/_shared/agent/runner.test.ts
git commit -m "feat(agent): runCommitmentScan extraction loop + recordCommitment dep"
```

---

## Task 10: Implement deps in `build-deps.ts`

**Files:**
- Modify: `supabase/functions/_shared/agent/build-deps.ts`

> Read `build-deps.ts` fully first — it already constructs the `RunnerDeps` object and exports `loadGmailAccessToken` / `loadOutlookAccessToken`. You're adding one dep to the returned object and three standalone helpers the edge fn imports.

- [ ] **Step 1: Implement `recordCommitment` in the deps object**

Inside `buildDeps`, add to the returned `RunnerDeps`:

```ts
    recordCommitment: async (uid, _runId, c) => {
      // Upsert on the (user_id, thread_id, direction) unique key. onConflict
      // refreshes the mutable fields so a re-scan updates rather than dupes,
      // but never resurrects a resolved/dismissed row (status untouched here).
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
        }, { onConflict: 'user_id,thread_id,direction', ignoreDuplicates: false })
        .select('id');
      if (error) throw error;
      return 'inserted';
    },
```

> Note: `ignoreDuplicates: false` makes this a real upsert (update on conflict). This is the one place we deliberately overwrite on conflict — see `feedback_supabase_upsert_overwrite.md`; here overwrite is intended (refresh summary/due) and never touches `status`, so a resolved loop stays resolved.

- [ ] **Step 2: Add the edge-fn helper exports**

At the bottom of `build-deps.ts`, export three helpers (standalone functions, not part of `RunnerDeps`):

```ts
import type { ScanCandidate } from './prompt.ts';
import type { CommitmentRow } from './commitments.ts';

// Fetch recent SENT threads as scan candidates. Gmail: in:sent newer_than:7d.
// One representative message per thread (the user's own latest text in it).
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
        out.push({
          thread_id: msg.threadId,
          provider: 'google',
          counterparty: h('to'),
          subject: h('subject'),
          latest_text: msg.snippet ?? '',
          latest_from: 'user',
          latest_at: h('date') ? new Date(h('date')).toISOString() : new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('no google refresh token')) console.warn('[agent-commitments] sent scan (google) failed for', userId, msg);
  }
  // Outlook sent items — Slice 2 extends this; Gmail-only candidates in Slice 1.
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
```

> `latest_from` is always `'user'` in Slice 1 because we only scan `in:sent`. The `counterparty` from the `To` header may carry a display-name+address; that's fine for the nudge copy.

- [ ] **Step 3: Typecheck**

Run: `deno check supabase/functions/_shared/agent/build-deps.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/agent/build-deps.ts
git commit -m "feat(agent): commitment deps — recordCommitment, sent-scan, open-select, watermark"
```

---

## Task 11: The `agent-commitments` edge function

**Files:**
- Create: `supabase/functions/agent-commitments/index.ts`

> Model this on `supabase/functions/agent-reflect/index.ts` — same auth (`x-cron-secret`), same `selectAgentEnabledUsers` + timezone + `isQuietHours` gating, same per-user try/catch + results array.

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/agent-commitments/index.ts
//
// Commitment sweep (~every 2h). Per agent_enabled user:
//   Phase 1 (watermark-gated): scan recent sent mail → extract you_owe commitments.
//   Phase 2 (every run): expire stale rows, then fire one templated nudge per due loop.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runCommitmentScan } from '../_shared/agent/runner.ts';
import {
  buildDeps,
  listSentCandidates,
  selectOpenCommitments,
  updateCommitment,
  markScanned,
} from '../_shared/agent/build-deps.ts';
import { applyReconcile, selectDue, buildCommitmentNudge } from '../_shared/agent/commitments.ts';
import { isQuietHours } from '../_shared/agent/quiet-hours.ts';

const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
if (!CRON_SECRET) throw new Error('[agent-commitments] CRON_SHARED_SECRET is not set — refusing to start');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SCAN_STALE_MS = 6 * 60 * 60 * 1000; // re-extract at most every 6h per user

async function selectAgentEnabledUsers(client: SupabaseClient): Promise<Array<{ userId: string; timezone: string; scannedAt: string | null }>> {
  const { data, error } = await client
    .from('user_profiles')
    .select('user_id, timezone, commitments_scanned_at')
    .eq('agent_enabled', true);
  if (error) throw error;
  const seen = new Set<string>();
  const out: Array<{ userId: string; timezone: string; scannedAt: string | null }> = [];
  for (const r of (data ?? []) as Array<{ user_id: string; timezone: string | null; commitments_scanned_at: string | null }>) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    out.push({ userId: r.user_id, timezone: r.timezone || 'Europe/Copenhagen', scannedAt: r.commitments_scanned_at });
  }
  return out;
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return new Response('unauthorized', { status: 401 });

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = new Date();
  const users = await selectAgentEnabledUsers(client);
  const results: Array<{ userId: string; scanned: boolean; nudged: number; reason?: string; error?: string }> = [];

  for (const { userId: uid, timezone, scannedAt } of users) {
    try {
      if (isQuietHours(now, timezone)) { results.push({ userId: uid, scanned: false, nudged: 0, reason: 'quiet_hours' }); continue; }
      const deps = buildDeps(client, uid);

      // Phase 1 — extraction, watermark-gated.
      let scanned = false;
      const stale = !scannedAt || (now.getTime() - new Date(scannedAt).getTime() > SCAN_STALE_MS);
      if (stale) {
        const candidates = await listSentCandidates(client, uid);
        if (candidates.length > 0) {
          await runCommitmentScan({ userId: uid, candidates, deps });
          scanned = true;
        }
        await markScanned(client, uid, now.toISOString());
      }

      // Phase 2 — reconcile (expire-only in Slice 1) + nudge.
      const open = await selectOpenCommitments(client, uid);
      for (const row of open) {
        const change = applyReconcile(row, { lastMessageAt: null, lastDirection: null }, now);
        if (change) { await updateCommitment(client, row.id, change); }
      }
      // Re-filter to still-open rows (drop the ones we just expired).
      const stillOpen = open.filter((r) => !applyReconcile(r, { lastMessageAt: null, lastDirection: null }, now));
      const due = selectDue(stillOpen, now);

      let nudged = 0;
      if (due.length > 0) {
        const runId = await deps.openRun(uid, 'commitments.nudge', []);
        for (const row of due) {
          const n = buildCommitmentNudge(row);
          const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
          const idemKey = `nudge.push:${n.action_kind}:${n.target_id}:${day}`;
          const { sent } = await deps.fireNudge({
            user_id: uid, run_id: runId,
            payload: { action_kind: n.action_kind, target_id: n.target_id, title: n.title, body: n.body, day, idem_key: idemKey },
            title: n.title, body: n.body,
            data: { type: 'nudge', action_kind: n.action_kind, target_id: n.target_id },
          });
          if (sent) {
            await updateCommitment(client, row.id, { status: 'nudged', nudged_at: now.toISOString() });
            nudged++;
          }
        }
        await deps.finishRun(runId, 'ok', { input_tokens: 0, output_tokens: 0 }, undefined, []);
      }

      results.push({ userId: uid, scanned, nudged });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error('[agent-commitments] error for', uid, msg);
      results.push({ userId: uid, scanned: false, nudged: 0, error: msg });
    }
  }

  return new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json' } });
});
```

- [ ] **Step 2: Typecheck the function**

Run: `deno check supabase/functions/agent-commitments/index.ts`
Expected: no errors. (If `fireNudge`'s `payload`/`data` shape differs in your `RunnerDeps`, match it to `runner.ts:142-149`.)

- [ ] **Step 3: Run the whole agent test suite to confirm nothing regressed**

Run the repo's standard agent test command (check `deno.json` tasks; e.g. `deno test supabase/functions/_shared/agent/`).
Expected: all green, including the pre-existing ~195 tests.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/agent-commitments/index.ts
git commit -m "feat(agent): agent-commitments sweep — extract + reconcile + nudge"
```

---

## Task 12: Deploy + verify no DB CHECK blocks the new values

**Files:** none (deploy + verification)

- [ ] **Step 1: Confirm `agent_runs.trigger` / `agent_actions.action_type` accept the new values**

The new trigger strings (`commitments.scan`, `commitments.nudge`) and action (`nudge.push`, already used) flow into `agent_runs.trigger` and `agent_actions.action_type`. Verify those columns have no restrictive CHECK/enum that would reject them:
Run (MCP `execute_sql`): `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.agent_runs'::regclass;` and the same for `public.agent_actions`.
Expected: no CHECK constraint enumerating trigger/action_type values (calendar-prep already added `reflect.sweep`, so these are free-text). If a CHECK exists, add a migration extending it before deploying.

- [ ] **Step 2: Deploy the edge function**

Deploy `agent-commitments` with `--no-verify-jwt` (cron-invoked, not user-auth — see `project_supabase_asymmetric_jwt.md`):
`supabase functions deploy agent-commitments --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop`
(Or MCP `deploy_edge_function`.) Confirm the deploy reports success and the function has `CRON_SHARED_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` in its env.

- [ ] **Step 3: Smoke-invoke once manually**

Invoke with the cron secret header against the function URL (POST). Expected: `200` with a `{ results: [...] }` body; per-user entries show `scanned`/`nudged` counts and no `error`.

- [ ] **Step 4: Commit (deploy is not a code change; no commit needed)**

Nothing to commit. Proceed to live smoke.

---

## Task 13: Cron registration

**Files:**
- Create: `supabase/schedule-agent-commitments.sql.template`

- [ ] **Step 1: Write the cron template**

Model on the existing `schedule-*.sql.template` files (open one to copy the exact `cron.schedule` + `net.http_post` shape, secret injection, and headers used by agent-reflect):

```sql
-- Manually apply in the Supabase SQL editor (templates are NOT auto-applied).
-- Replace PASTE_CRON_SHARED_SECRET and PASTE_SERVICE_ROLE_KEY (sb_secret_… value).
select cron.schedule(
  'agent-commitments-sweep',
  '0 */2 * * *',
  $$
  select net.http_post(
    url := 'https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/agent-commitments',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', 'PASTE_CRON_SHARED_SECRET',
      'authorization', 'Bearer PASTE_SERVICE_ROLE_KEY'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

- [ ] **Step 2: Apply it in the Supabase SQL editor**

Paste with the real secret + service-role (`sb_secret_…`) value substituted. Run.

- [ ] **Step 3: Verify the cron row exists**

Run: `select jobid, jobname, schedule, active from cron.job where jobname = 'agent-commitments-sweep';`
Expected: one active row, schedule `0 */2 * * *`. (Per `project_cron_template_apply.md`, this verification is mandatory — a template alone does nothing.)

- [ ] **Step 4: Commit**

```bash
git add supabase/schedule-agent-commitments.sql.template
git commit -m "feat(agent): cron template for agent-commitments sweep"
```

---

## Task 14: Live end-to-end smoke (the non-negotiable gate)

**Files:** none. Test account: `albertfeldt1@gmail.com` (`user_test_accounts.md`).

- [ ] **Step 1: Seed a real promise**

From the test account, send yourself (or a co-conspirator) a mail whose body contains a clear Danish promise with a near deadline, e.g. *"Hej — jeg sender dig Q3-decket i morgen."* Make sure the account has a push token registered (open the app once).

- [ ] **Step 2: Force an extraction run**

Clear the watermark so extraction definitely runs: `update user_profiles set commitments_scanned_at = null where user_id = '<test uid>';` then manually invoke the function (Task 12 Step 3).

- [ ] **Step 3: Assert a commitment row was created**

Run: `select direction, counterparty, summary, due_at, due_inferred, status from agent_commitments where user_id = '<test uid>' order by created_at desc limit 5;`
Expected: a `you_owe` row whose `summary` reflects the promise; `due_at` set (inferred or explicit).

- [ ] **Step 4: Assert a nudge fires when due**

If `due_at` is within 24h it should nudge on the same invoke. If not, temporarily set it close: `update agent_commitments set due_at = now() + interval '1 hour' where id = '<row id>';` then invoke again.
Expected: a push notification arrives on the device with the templated copy; `agent_commitments.status` flips to `nudged`, `nudged_at` set; a matching `agent_actions` row with `action_type='nudge.push'`, idem key `nudge.push:commitment:<thread_id>:<day>`.

- [ ] **Step 5: Assert daily dedup**

Invoke once more without changing anything.
Expected: no second push; `selectDue` skips the row (already nudged today); function `results` shows `nudged: 0` for the user.

- [ ] **Step 6: Update project memory**

Write/refresh a memory noting Slice 1 shipped (table + extraction + nudge live, Slice 2 = `owed_to_you`/stale detection, Slice 3 = reconciliation-via-thread-reads + in-app list), linking `[[project-agent-reflect-calendar-prep]]` and `[[phase-4-next-pickup-state]]`. Add the `MEMORY.md` index line.

---

## Deferred to follow-on plans (NOT this slice)

- **Slice 2 — `owed_to_you` / stale-thread detection:** extend `listSentCandidates` into a stale-thread reader (last-message direction + age), feed both directions to extraction, enable the `owed_to_you` nudge path (the pure `selectDue`/`buildCommitmentNudge`/`applyReconcile` branches already handle it and are tested). Outlook sent-items reader lands here too.
- **Slice 3 — reconciliation via thread reads + in-app "Open loops" list:** replace the expire-only reconcile with real per-thread last-message reads (resolve loops when the thread moves), and build the client screen (read via the owner RLS select policy) with manual resolve/dismiss.

---

## Self-Review

**Spec coverage** (against `2026-05-31-commitment-tracking-design.md`):
- §4 data model → Task 1. ✓
- §5 extraction (sent, `commitment.record`, due inference, watermark) → Tasks 7/8/9/10/11; `you_owe`-from-sent only in Slice 1 (spec §9 sequences this first). ✓
- §6 reconcile + due-nudge → Tasks 3/4/5/11; **nudge is deterministic-templated**, a user-approved deviation from spec §6's Claude-routed nudge (recorded in this plan's header + Task 5). ✓
- §7 edge handling (per-provider swallow, quiet-hours-before-insert, budget) → Task 11. ✓
- §10 new-tool checklist → Tasks 6/7/8/9 cover every seam (types, prompt map + catalogue, SUPPORTED/NON_THREAD sets, dispatch); cron caveat → Task 13. ✓
- `owed_to_you` full path + in-app list explicitly deferred (spec §2 non-goals / §9 slices). ✓

**Placeholder scan:** no TBD/TODO; every code step has complete code; the one `<timestamp>`/`<test uid>`/`<row id>` tokens are genuine fill-ins the implementer substitutes at runtime, not unfinished logic.

**Type consistency:** `ScanCandidate` (prompt.ts) is the single shape used by `buildCommitmentScanPrompt`, `runCommitmentScan`, and `listSentCandidates`. `CommitmentRow` (commitments.ts) is used by `selectDue`/`applyReconcile`/`buildCommitmentNudge`/`selectOpenCommitments`. `recordCommitment(userId, runId, commitment)` signature matches between the `RunnerDeps` declaration (Task 9), the call site (Task 9), and the implementation (Task 10). `applyReconcile` return shape (`{status:'resolved',resolved_at}` | `{status:'expired'}` | null) is consumed directly as the `updateCommitment` patch in Task 11. ✓
