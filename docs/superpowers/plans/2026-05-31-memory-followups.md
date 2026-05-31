# Memory Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a stored fact carries a future date, Zolva surfaces it as the date nears — a push nudge, or a drafted reply when the agent can find a relevant thread.

**Architecture:** A new `agent-memory-followups` edge function on cron mirrors `agent-reflect`: per `agent_enabled` user (quiet-hours gated) it reads `confirmed` facts whose `follow_up_at` has passed and `followed_up_at` is null, emits one deduped `fact.due` `agent_event` per fact, runs a `memoryFollowupStrategy` through the existing `executeRun` (tools: nudge / mail_search / mail_get_body / mail_draft_reply / mail_send_reply), then stamps `followed_up_at`. The `follow_up_at` value is set client-side by the existing chat fact-extractor from the date it already extracts (`referentDate`). No new ActionType.

**Tech Stack:** Supabase (Postgres + edge functions, Deno), TypeScript, React Native (Expo) client, Claude via the shared agent runner, `deno test` + Jest.

---

## Background the engineer needs

- **The agent runner pattern.** `supabase/functions/_shared/agent/runner.ts` exposes `executeRun(userId, trigger, events, deps, strategy)`. A *strategy* (`AgentStrategy`, runner.ts:30) supplies `buildContext` (system+messages+tools), `seedAllowlist`, `extendAllowlist`. `runReflect` (runner.ts:647) is the closest existing wrapper — copy its shape. `reflectStrategy` (runner.ts:619) reads event payloads and calls `buildReflectPrompt`; mirror it.
- **The sweep pattern.** `supabase/functions/agent-reflect/index.ts` is the template for the new edge function: cron-secret gate, `selectAgentEnabledUsers`, per-user `try/catch`, `isQuietHours` skip, emit deduped `agent_events`, call the runner. Copy it closely.
- **Pure selection module.** `supabase/functions/_shared/agent/reflect-events.ts` (`filterUpcomingEvents`, `toUpcomingPayload`) is the template for the new `followup-facts.ts`.
- **The fact extractor (client).** `src/lib/profile-extractor.ts` already extracts an optional `referentDate` (ISO `YYYY-MM-DD`) and derives `expires_at` via `computeExpiresAt` (profile-extractor.ts:68). We add a parallel `computeFollowUpAt` and thread it through `insertPendingFact` (`src/lib/profile-store.ts:107`).
- **Facts lifecycle.** Facts insert as `status='pending'`; the sweep only acts on `status='confirmed'`. `follow_up_at` is set at insert time but only fires after the user confirms the fact — a free safety gate.
- **`agent_events.kind`** has no CHECK constraint (free-text), and `AgentEventKind` (types.ts:3) already includes `'fact.due'`. No type or constraint change needed to emit `fact.due`.
- **Conventions.** Conventional Commits, scope `agent`, bullet bodies, no AI attribution, don't push from the working terminal. Server (`supabase/functions/**` + migrations) gets its own commit and deploys before any client change. Run `deno test supabase/functions/_shared/agent/` for server tests, `npx jest <path>` for client tests.

---

## Task 1: Add `follow_up_at` / `followed_up_at` columns to `facts`

**Files:**
- Create: `supabase/migrations/20260531150000_facts_follow_up.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260531150000_facts_follow_up.sql
--
-- Memory follow-ups: a fact can carry a future moment to resurface for action
-- (follow_up_at), set client-side by the chat extractor from the date it already
-- extracts. followed_up_at is stamped once the agent-memory-followups sweep has
-- acted, so each fact fires exactly once. Mirrors 20260427100000_facts_expires_at.

ALTER TABLE public.facts
  ADD COLUMN IF NOT EXISTS follow_up_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followed_up_at TIMESTAMPTZ;

-- Partial index: the sweep selects confirmed facts whose follow_up_at has passed
-- and that have not yet been acted on. Only follow-up-bearing rows are indexed.
CREATE INDEX IF NOT EXISTS facts_follow_up_due_idx
  ON public.facts (user_id, follow_up_at)
  WHERE follow_up_at IS NOT NULL AND followed_up_at IS NULL;
```

- [ ] **Step 2: Apply the migration to the remote project**

Apply via the Supabase MCP `apply_migration` tool (name `facts_follow_up`, the SQL above), or `supabase db push`. This is a server change — it lands before any client/edge change ships.

- [ ] **Step 3: Verify the columns exist**

Run this SQL (MCP `execute_sql`) and confirm both columns are present:

```sql
select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='facts'
  and column_name in ('follow_up_at','followed_up_at')
order by column_name;
```
Expected: two rows, both `timestamp with time zone`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260531150000_facts_follow_up.sql
git commit -m "feat(agent): facts.follow_up_at + followed_up_at for memory follow-ups"
```

---

## Task 2: Client — derive `follow_up_at` in the extractor (pure function + wire)

**Files:**
- Modify: `src/lib/profile-extractor.ts` (add `computeFollowUpAt`, pass to `insertPendingFact`)
- Test: `src/lib/__tests__/profile-extractor-followup.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/profile-extractor-followup.test.ts
import { computeFollowUpAt } from '../profile-extractor';

describe('computeFollowUpAt', () => {
  it('returns the referent day at 00:00Z for an actionable dated fact', () => {
    expect(computeFollowUpAt('commitment', '2026-06-12')?.toISOString())
      .toBe('2026-06-12T00:00:00.000Z');
    expect(computeFollowUpAt('other', '2026-06-12')?.toISOString())
      .toBe('2026-06-12T00:00:00.000Z');
  });

  it('returns null for non-actionable categories even with a date', () => {
    expect(computeFollowUpAt('preference', '2026-06-12')).toBeNull();
    expect(computeFollowUpAt('relationship', '2026-06-12')).toBeNull();
  });

  it('returns null when there is no valid referent date', () => {
    expect(computeFollowUpAt('commitment', null)).toBeNull();
    expect(computeFollowUpAt('commitment', undefined)).toBeNull();
    expect(computeFollowUpAt('commitment', 'fredag')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx jest src/lib/__tests__/profile-extractor-followup.test.ts`
Expected: FAIL — `computeFollowUpAt` is not exported.

- [ ] **Step 3: Add `computeFollowUpAt` and export it**

In `src/lib/profile-extractor.ts`, just after `computeExpiresAt` (around line 77), add:

```typescript
// Follow-up-eligible categories are the actionable ones (same set that decays).
// A memory follow-up only makes sense for a thing-to-do, not a preference/role.
const FOLLOWUP_CATEGORIES: ReadonlySet<FactCategory> = DECAY_CATEGORIES;

// follow_up_at = the referent day at 00:00 UTC (~02:00 Copenhagen). The sweep is
// quiet-hours gated, so an overnight-due fact actually surfaces the first sweep
// after quiet hours that morning. Null when the fact is not a dated actionable
// item — those never enter the follow-up sweep. v1 surfaces ON the day; a smarter
// lead (e.g. two weeks before an expiry) is a future refinement.
export function computeFollowUpAt(
  category: FactCategory,
  referentDate: string | null | undefined,
): Date | null {
  if (!FOLLOWUP_CATEGORIES.has(category)) return null;
  if (referentDate && /^\d{4}-\d{2}-\d{2}$/.test(referentDate)) {
    const base = Date.parse(`${referentDate}T00:00:00Z`);
    if (Number.isFinite(base)) return new Date(base);
  }
  return null;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx jest src/lib/__tests__/profile-extractor-followup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Thread `followUpAt` into the insert call**

In `src/lib/profile-extractor.ts`, find the `insertPendingFact` call (around line 135) and add the `followUpAt` field:

```typescript
await insertPendingFact(payload.userId, {
  text: c.text.trim(),
  category: c.category,
  source: payload.source,
  expiresAt: computeExpiresAt(c.category, c.referentDate ?? null),
  followUpAt: computeFollowUpAt(c.category, c.referentDate ?? null),
});
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/profile-extractor.ts src/lib/__tests__/profile-extractor-followup.test.ts
git commit -m "feat(agent): derive facts.follow_up_at in the chat extractor"
```

---

## Task 3: Client — persist `follow_up_at` in `insertPendingFact`

**Files:**
- Modify: `src/lib/profile-store.ts` (`insertPendingFact`, lines 107-135)

- [ ] **Step 1: Add `followUpAt` to the input type**

In `src/lib/profile-store.ts`, extend the `insertPendingFact` input (around line 110):

```typescript
export async function insertPendingFact(
  userId: string,
  input: {
    text: string;
    category: FactCategory;
    source: string | null;
    // Optional decay timestamp. NULL means "permanent".
    expiresAt?: Date | null;
    // Optional follow-up moment — when the memory-followups sweep should surface
    // this fact. NULL means no follow-up. Only set for dated actionable facts.
    followUpAt?: Date | null;
  },
): Promise<Fact> {
```

- [ ] **Step 2: Write the column in the insert**

In the same function, add `follow_up_at` to the `.insert({...})` object (after `expires_at`):

```typescript
    .insert({
      user_id: userId,
      text: input.text,
      normalized_text: normalized,
      category: input.category,
      status: 'pending',
      source: input.source,
      expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      follow_up_at: input.followUpAt ? input.followUpAt.toISOString() : null,
    })
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "profile-store|profile-extractor" || echo "clean"`
Expected: `clean` (pre-existing unrelated errors elsewhere are fine).

- [ ] **Step 4: Commit**

```bash
git add src/lib/profile-store.ts
git commit -m "feat(agent): persist follow_up_at on pending fact insert"
```

---

## Task 4: Pure selection module `followup-facts.ts`

**Files:**
- Create: `supabase/functions/_shared/agent/followup-facts.ts`
- Test: `supabase/functions/_shared/agent/followup-facts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/_shared/agent/followup-facts.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { selectDueFollowups, toFactDuePayload } from './followup-facts.ts';
import type { FollowupFactRow } from './followup-facts.ts';

function fact(over: Partial<FollowupFactRow>): FollowupFactRow {
  return {
    id: 'f1', text: 'du skal forny dit pas', category: 'commitment',
    follow_up_at: '2026-06-12T00:00:00Z', followed_up_at: null, status: 'confirmed',
    ...over,
  };
}

Deno.test('selectDueFollowups picks a confirmed, due, un-acted fact', () => {
  const now = new Date('2026-06-12T07:00:00Z');
  assertEquals(selectDueFollowups([fact({})], now).map((f) => f.id), ['f1']);
});

Deno.test('selectDueFollowups skips a fact not yet due', () => {
  const now = new Date('2026-06-11T07:00:00Z');
  assertEquals(selectDueFollowups([fact({})], now), []);
});

Deno.test('selectDueFollowups skips a fact already followed up', () => {
  const now = new Date('2026-06-12T07:00:00Z');
  assertEquals(selectDueFollowups([fact({ followed_up_at: '2026-06-12T06:00:00Z' })], now), []);
});

Deno.test('selectDueFollowups skips non-confirmed facts', () => {
  const now = new Date('2026-06-12T07:00:00Z');
  assertEquals(selectDueFollowups([fact({ status: 'pending' })], now), []);
});

Deno.test('selectDueFollowups skips null / invalid follow_up_at', () => {
  const now = new Date('2026-06-12T07:00:00Z');
  assertEquals(selectDueFollowups([fact({ follow_up_at: null })], now), []);
  assertEquals(selectDueFollowups([fact({ follow_up_at: 'nope' })], now), []);
});

Deno.test('selectDueFollowups boundary: due exactly now is included', () => {
  const now = new Date('2026-06-12T00:00:00Z');
  assertEquals(selectDueFollowups([fact({})], now).length, 1);
});

Deno.test('toFactDuePayload carries fact fields + day', () => {
  const p = toFactDuePayload(fact({}), '2026-06-12');
  assertEquals(p.fact_id, 'f1');
  assertEquals(p.text, 'du skal forny dit pas');
  assertEquals(p.day, '2026-06-12');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `deno test supabase/functions/_shared/agent/followup-facts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```typescript
// supabase/functions/_shared/agent/followup-facts.ts
//
// Pure selection of which facts are due for a memory follow-up. The DB query in
// the sweep already filters (confirmed, follow_up_at <= now, followed_up_at
// null); this re-applies the same predicate so the logic is unit-tested rather
// than assumed (this codebase's habit: prove the layer).

export interface FollowupFactRow {
  id: string;
  text: string;
  category: string;
  follow_up_at: string | null;   // ISO
  followed_up_at: string | null; // ISO, set once acted
  status: string;                // 'confirmed' expected
}

export function selectDueFollowups(facts: FollowupFactRow[], now: Date): FollowupFactRow[] {
  const nowMs = now.getTime();
  return facts.filter((f) => {
    if (f.status !== 'confirmed') return false;
    if (f.followed_up_at) return false;
    if (!f.follow_up_at) return false;
    const due = new Date(f.follow_up_at).getTime();
    return !Number.isNaN(due) && due <= nowMs;
  });
}

// fact.due agent_event payload. day is the Copenhagen calendar day, used by the
// per-day dedup index so a fact emits at most one event per day.
export function toFactDuePayload(f: FollowupFactRow, day: string): Record<string, unknown> {
  return { fact_id: f.id, text: f.text, category: f.category, follow_up_at: f.follow_up_at, day };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `deno test supabase/functions/_shared/agent/followup-facts.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/followup-facts.ts supabase/functions/_shared/agent/followup-facts.test.ts
git commit -m "feat(agent): pure selectDueFollowups + fact.due payload"
```

---

## Task 5: Prompt + tool catalogue for the follow-up strategy

**Files:**
- Modify: `supabase/functions/_shared/agent/prompt.ts` (add `FollowupFact`, `buildMemoryFollowupPrompt`, `MEMORY_FOLLOWUP_TOOLS`)
- Test: `supabase/functions/_shared/agent/followup-prompt.test.ts`

Note the existing tool exports in prompt.ts to reuse: `NUDGE_PUSH_TOOL`, `MAIL_SEARCH_TOOL`, `MAIL_GET_BODY_TOOL`, and the mail draft/send tools inside `MAIL_TRIAGE_TOOLS` (`mail_draft_reply`, `mail_send_reply`). `REFLECT_TOOLS` (prompt.ts:218) shows the pattern `[MAIL_SEARCH_TOOL, MAIL_GET_BODY_TOOL, NUDGE_PUSH_TOOL]`.

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/_shared/agent/followup-prompt.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildMemoryFollowupPrompt, MEMORY_FOLLOWUP_TOOLS } from './prompt.ts';

Deno.test('buildMemoryFollowupPrompt lists each fact with its id and text', () => {
  const { system, messages } = buildMemoryFollowupPrompt({
    facts: [{ fact_id: 'f1', text: 'du skal forny dit pas', follow_up_at: '2026-06-12T00:00:00Z' }],
    nowIso: '2026-06-12T07:00:00Z',
  });
  assertEquals(system.length > 0, true);
  const body = messages[0].content as string;
  assertEquals(body.includes('f1'), true);
  assertEquals(body.includes('du skal forny dit pas'), true);
});

Deno.test('MEMORY_FOLLOWUP_TOOLS exposes nudge + search + body + draft + send', () => {
  const names = MEMORY_FOLLOWUP_TOOLS.map((t) => (t as { name: string }).name);
  assertEquals(names.includes('nudge_push'), true);
  assertEquals(names.includes('mail_search'), true);
  assertEquals(names.includes('mail_draft_reply'), true);
  assertEquals(names.includes('mail_send_reply'), true);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `deno test supabase/functions/_shared/agent/followup-prompt.test.ts`
Expected: FAIL — `buildMemoryFollowupPrompt` / `MEMORY_FOLLOWUP_TOOLS` not exported.

- [ ] **Step 3: Add the system prompt, builder, and tool catalogue**

In `supabase/functions/_shared/agent/prompt.ts`, after the reflect prompt section (near `REFLECT_TOOLS`, line 218), add. First, locate the named tool consts to compose the catalogue — `MAIL_SEARCH_TOOL`, `MAIL_GET_BODY_TOOL`, `NUDGE_PUSH_TOOL` already exist; the draft/send tools live inside `MAIL_TRIAGE_TOOLS`. Pull the two draft/send tools by name so the catalogue is explicit:

```typescript
const MAIL_DRAFT_REPLY_TOOL = MAIL_TRIAGE_TOOLS.find((t) => t.name === 'mail_draft_reply')!;
const MAIL_SEND_REPLY_TOOL = MAIL_TRIAGE_TOOLS.find((t) => t.name === 'mail_send_reply')!;

export const MEMORY_FOLLOWUP_TOOLS = [
  NUDGE_PUSH_TOOL,
  MAIL_SEARCH_TOOL,
  MAIL_GET_BODY_TOOL,
  MAIL_DRAFT_REPLY_TOOL,
  MAIL_SEND_REPLY_TOOL,
] as const;

const MEMORY_FOLLOWUP_SYSTEM_PROMPT = `Du er Zolva. Brugeren har gemt nogle fakta med en dato, og den dato er nu kommet.

For hvert faktum i brugerens besked:
- Afgør om en kort heads-up reelt hjælper brugeren i dag. I tvivl: gør ingenting for det faktum.
- Hvis det handler om at kontakte en bestemt person, må du først kalde mail_search (på personens navn eller emne) for at finde en relateret tråd, og mail_get_body for at læse den. Du må KUN læse tråde som mail_search har returneret — opfind ALDRIG et thread_id. Derefter må du udkaste et svar (mail_draft_reply) og foreslå det (mail_send_reply i SAMME tur, med præcis det draft_id og draft_hash som mail_draft_reply returnerede).
- Ellers send PRÆCIS én nudge_push: en kort dansk påmindelse der nævner fakta-teksten. Maks. én nudge pr. faktum. Brug fact_id som target_id og 'memory_followup' som action_kind.

Regler:
- Svar kort på dansk efter værktøjskald. Vær konservativ: en påmindelse er bedre end en upassende mail.`;

export interface FollowupFact {
  fact_id: string;
  text: string;
  follow_up_at: string;
}

export function buildMemoryFollowupPrompt(input: { facts: FollowupFact[]; nowIso?: string }): BuildMailTriagePromptResult {
  const system: ClaudeSystemBlock[] = [
    { type: 'text', text: MEMORY_FOLLOWUP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  const dateLine = input.nowIso
    ? `Dags dato: ${formatDanishDate(input.nowIso)} (tidszone Europe/Copenhagen).`
    : '';
  const lines = input.facts.map((f) => `- fact_id=${f.fact_id} | tekst=${f.text}`);
  const body = [...(dateLine ? [dateLine, ''] : []), 'Følg op på disse:', '', ...lines].join('\n');
  return { system, messages: [{ role: 'user', content: body }] };
}
```

(`BuildMailTriagePromptResult`, `ClaudeSystemBlock`, and `formatDanishDate` are already imported/defined in prompt.ts — the reflect builder uses all three.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `deno test supabase/functions/_shared/agent/followup-prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/prompt.ts supabase/functions/_shared/agent/followup-prompt.test.ts
git commit -m "feat(agent): memory follow-up system prompt + tool catalogue"
```

---

## Task 6: Runner — `memoryFollowupStrategy` + `runMemoryFollowup`

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts` (add strategy + wrapper, after `reflectStrategy`/`runReflect`)

- [ ] **Step 1: Extend the prompt import**

At the top of `runner.ts`, add `buildMemoryFollowupPrompt, MEMORY_FOLLOWUP_TOOLS` to the existing import from `./prompt.ts` (runner.ts:19).

- [ ] **Step 2: Add the strategy + wrapper**

After `runReflect` (runner.ts:653), add:

```typescript
// Memory-followups path (agent-memory-followups): context is the due facts,
// carried on fact.due event payloads. Same read+nudge+draft tools as triage,
// EMPTY allowlist (the agent may only read threads mail_search returned this run
// — identical safety model to reflect).
export const memoryFollowupStrategy: AgentStrategy = {
  async buildContext(_userId, events, _deps) {
    const facts = events.map((e) => ({
      fact_id: String(e.payload.fact_id ?? ''),
      text: String(e.payload.text ?? ''),
      follow_up_at: String(e.payload.follow_up_at ?? ''),
    }));
    const { system, messages } = buildMemoryFollowupPrompt({ facts, nowIso: new Date().toISOString() });
    return { system, messages, tools: MEMORY_FOLLOWUP_TOOLS };
  },
  seedAllowlist: () => new Set<string>(),
  extendAllowlist: (action, recordPayload) => {
    if (action !== 'mail.search') return [];
    const hits = Array.isArray(recordPayload.hits) ? recordPayload.hits : [];
    return hits.map((h) => (h && typeof h === 'object' ? String((h as { thread_id?: unknown }).thread_id ?? '') : '')).filter(Boolean);
  },
};

export interface RunMemoryFollowupInput {
  userId: string;
  events: ClaimedEvent[]; // already-claimed fact.due rows
  deps: RunnerDeps;
}

export async function runMemoryFollowup(input: RunMemoryFollowupInput): Promise<RunResult> {
  const { userId, events, deps } = input;
  const budget = await deps.checkBudget(userId);
  if (budget.exceeded) return { runId: null, processed: 0, status: 'budget_exceeded' };
  if (events.length === 0) return { runId: null, processed: 0, status: 'ok' };
  return executeRun(userId, 'memory.followup', events, deps, memoryFollowupStrategy);
}
```

- [ ] **Step 3: Allow the new trigger string**

`executeRun` passes `trigger` to `deps.openRun`. Confirm `AgentRunTrigger` (in `types.ts`) is a string-union and add `'memory.followup'` to it. If `agent_runs.trigger` has no DB CHECK (it does not — only `status` is checked), no migration is needed.

Run: `grep -n "AgentRunTrigger" supabase/functions/_shared/agent/types.ts` and add `| 'memory.followup'` to the union.

- [ ] **Step 4: Typecheck the runner**

Run: `deno check supabase/functions/_shared/agent/runner.ts`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts supabase/functions/_shared/agent/types.ts
git commit -m "feat(agent): memoryFollowupStrategy + runMemoryFollowup"
```

---

## Task 7: build-deps — read due facts + stamp followed_up_at

**Files:**
- Modify: `supabase/functions/_shared/agent/build-deps.ts` (add two exported helpers near `selectOpenCommitments`/`updateCommitment`)

- [ ] **Step 1: Add the read + write helpers**

At the end of `build-deps.ts`, mirroring `selectOpenCommitments` (build-deps.ts) and `updateCommitment`:

```typescript
import type { FollowupFactRow } from './followup-facts.ts'; // add to the existing imports at top

// Confirmed facts whose follow-up is due and not yet acted. The partial index
// facts_follow_up_due_idx backs this predicate.
export async function selectDueFollowupFacts(
  client: SupabaseClient,
  userId: string,
  nowIso: string,
): Promise<FollowupFactRow[]> {
  const { data, error } = await client
    .from('facts')
    .select('id, text, category, follow_up_at, followed_up_at, status')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .is('followed_up_at', null)
    .not('follow_up_at', 'is', null)
    .lte('follow_up_at', nowIso);
  if (error) throw error;
  return (data ?? []) as FollowupFactRow[];
}

// Stamp followed_up_at so each fact fires exactly once.
export async function markFactsFollowedUp(
  client: SupabaseClient,
  factIds: string[],
  nowIso: string,
): Promise<void> {
  if (factIds.length === 0) return;
  const { error } = await client.from('facts').update({ followed_up_at: nowIso }).in('id', factIds);
  if (error) throw error;
}
```

(Put the `import type { FollowupFactRow }` line with the other `./` imports at the top of build-deps.ts, next to the `commitments.ts` import.)

- [ ] **Step 2: Typecheck**

Run: `deno check supabase/functions/_shared/agent/build-deps.ts`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/agent/build-deps.ts
git commit -m "feat(agent): build-deps readers for due follow-up facts"
```

---

## Task 8: The `agent-memory-followups` edge function

**Files:**
- Create: `supabase/functions/agent-memory-followups/index.ts`

This is a close copy of `supabase/functions/agent-reflect/index.ts` — same cron-secret gate, `selectAgentEnabledUsers`, per-user `try/catch`, quiet-hours skip, deduped `agent_events` insert, runner call. The differences: it reads facts instead of calendars, emits `fact.due` instead of `calendar.upcoming`, calls `runMemoryFollowup`, and stamps `followed_up_at` after the run.

- [ ] **Step 1: Write the edge function**

```typescript
// supabase/functions/agent-memory-followups/index.ts
//
// Memory-followups sweep (~hourly daytime). Per agent_enabled user, quiet-hours
// gated: read confirmed facts whose follow_up_at has passed and that have not
// been acted on, emit one deduped fact.due event per fact, run the followup
// strategy, then stamp followed_up_at so each fires once. Mirrors agent-reflect.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runMemoryFollowup } from '../_shared/agent/runner.ts';
import type { ClaimedEvent } from '../_shared/agent/runner.ts';
import { buildDeps, selectDueFollowupFacts, markFactsFollowedUp } from '../_shared/agent/build-deps.ts';
import { selectDueFollowups, toFactDuePayload } from '../_shared/agent/followup-facts.ts';
import { isQuietHours } from '../_shared/agent/quiet-hours.ts';

const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
if (!CRON_SECRET) {
  throw new Error('[agent-memory-followups] CRON_SHARED_SECRET is not set — refusing to start');
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function copenhagenDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

async function selectAgentEnabledUsers(
  client: SupabaseClient,
): Promise<Array<{ userId: string; timezone: string }>> {
  const { data, error } = await client
    .from('user_profiles')
    .select('user_id, timezone')
    .eq('agent_enabled', true);
  if (error) throw error;
  const seen = new Set<string>();
  const out: Array<{ userId: string; timezone: string }> = [];
  for (const r of (data ?? []) as Array<{ user_id: string; timezone: string | null }>) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    out.push({ userId: r.user_id, timezone: r.timezone || 'Europe/Copenhagen' });
  }
  return out;
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = new Date();
  const nowIso = now.toISOString();
  const day = copenhagenDay(now);
  const users = await selectAgentEnabledUsers(client);

  const results: Array<{ userId: string; ran: boolean; reason?: string; error?: string }> = [];
  for (const { userId: uid, timezone } of users) {
    try {
      if (isQuietHours(now, timezone)) {
        results.push({ userId: uid, ran: false, reason: 'quiet_hours' });
        continue;
      }

      const dueRows = selectDueFollowups(await selectDueFollowupFacts(client, uid, nowIso), now);
      if (dueRows.length === 0) {
        results.push({ userId: uid, ran: false });
        continue;
      }

      // Emit one deduped fact.due event per fact (mirrors reflect's per-row insert;
      // the agent_events_fact_due_dedup unique index raises 23505 once per day).
      const fresh: ClaimedEvent[] = [];
      const factIds: string[] = [];
      for (const f of dueRows) {
        const payload = toFactDuePayload(f, day);
        const { data, error } = await client
          .from('agent_events')
          .insert({ user_id: uid, kind: 'fact.due', payload })
          .select('id, kind, payload')
          .single();
        if (error) {
          if ((error as { code?: string }).code === '23505') continue; // already emitted today
          throw error;
        }
        fresh.push(data as ClaimedEvent);
        factIds.push(f.id);
      }

      if (fresh.length === 0) {
        results.push({ userId: uid, ran: false });
        continue;
      }

      const deps = buildDeps(client, uid);
      await runMemoryFollowup({ userId: uid, events: fresh, deps });
      // Stamp followed_up_at regardless of per-fact action: the fact has been
      // surfaced to the agent this cycle; re-running daily would re-nudge.
      await markFactsFollowedUp(client, factIds, nowIso);
      results.push({ userId: uid, ran: true });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error('[agent-memory-followups] error for', uid, msg);
      results.push({ userId: uid, ran: false, error: msg });
    }
  }

  return new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json' } });
});
```

- [ ] **Step 2: Add the fact.due per-day dedup index**

Create `supabase/migrations/20260531150500_agent_events_fact_due_dedup.sql`:

```sql
-- One fact.due event per (user, fact, day) so a re-run within the day can't
-- double-emit. Mirrors agent_events_calendar_upcoming_dedup.
CREATE UNIQUE INDEX IF NOT EXISTS agent_events_fact_due_dedup
  ON public.agent_events (user_id, (payload->>'fact_id'), (payload->>'day'))
  WHERE kind = 'fact.due';
```

Apply via MCP `apply_migration` (name `agent_events_fact_due_dedup`).

- [ ] **Step 3: Typecheck the function**

Run: `deno check supabase/functions/agent-memory-followups/index.ts`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/agent-memory-followups/index.ts supabase/migrations/20260531150500_agent_events_fact_due_dedup.sql
git commit -m "feat(agent): agent-memory-followups sweep edge function"
```

---

## Task 9: Deploy + cron + smoke test

**Files:** none (deploy actions)

- [ ] **Step 1: Run the full server test suite**

Run: `deno test supabase/functions/_shared/agent/`
Expected: all pass (existing + the new followup-facts and followup-prompt tests).

- [ ] **Step 2: Deploy the function**

Run: `supabase functions deploy agent-memory-followups --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop`
Expected: `Deployed Functions on project ...: agent-memory-followups`.

- [ ] **Step 3: Health-check the auth gate**

Run: `curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://sjkhfkatmeqtsrysixop.functions.supabase.co/agent-memory-followups" -H "content-type: application/json" -d '{}'`
Expected: `401` (booted clean, cron-secret gate works).

- [ ] **Step 4: Create the cron job (clone agent-reflect-sweep's command)**

Run this SQL via MCP `execute_sql` — it clones the working cron command (secret + bearer) from `agent-reflect-sweep`, swapping the function name, so the secret never enters the agent context:

```sql
select cron.schedule(
  'agent-memory-followups-sweep',
  '0 7-21/3 * * *',  -- a few times across the day; quiet-hours gating in-fn
  replace(
    (select command from cron.job where jobname = 'agent-reflect-sweep'),
    'agent-reflect', 'agent-memory-followups'
  )
);
```

- [ ] **Step 5: Verify the cron row**

Run via MCP `execute_sql`:
```sql
select jobname, schedule, active from cron.job where jobname = 'agent-memory-followups-sweep';
```
Expected: one active row.

- [ ] **Step 6: Live smoke test**

Insert a confirmed, due follow-up fact for the test account (`albertfeldt1@gmail.com`, id `d02f1514-...`), trigger the sweep server-side via the cron command, confirm a `nudge.push` `agent_action` row appears and `followed_up_at` is stamped, then delete the test fact. (Mirror the commitment-tracking smoke recorded in project memory.)

- [ ] **Step 7: Final commit (if any cron template file was added)**

If you persisted the cron SQL as a `.sql.template`, commit it:
```bash
git add supabase/schedule-agent-memory-followups.sql.template
git commit -m "chore(agent): memory-followups cron schedule template"
```

---

## Self-review notes (already applied)

- **Spec coverage:** §4.1 columns (Task 1), §4.2 producer/extractor (Tasks 2-3), §4.3 sweep + strategy + nudge/draft (Tasks 4-8), §4.4 once-only (`followed_up_at`, Tasks 4/7/8), no new ActionType (confirmed — reuses nudge + mail tools). Standing tasks intentionally out of scope.
- **Type consistency:** `FollowupFactRow` (followup-facts.ts) is the read shape used by build-deps and the sweep; `FollowupFact` (prompt.ts) is the prompt shape; `toFactDuePayload` bridges row→event payload→`memoryFollowupStrategy.buildContext`. `selectDueFollowups`/`selectDueFollowupFacts`/`markFactsFollowedUp` names are used identically across Tasks 4/7/8.
- **v1 simplification flagged:** `follow_up_at` surfaces ON the referent day (00:00Z, gated to morning by quiet hours); a smarter lead window is a noted future refinement, not a placeholder.
- **Verify-before-claim:** confirm `agent_events.kind` has no CHECK and `AgentRunTrigger` is an unconstrained string-union before relying on `'fact.due'` / `'memory.followup'` (both checked during planning: kind is free-text, only `agent_runs.status` is CHECK-constrained).
