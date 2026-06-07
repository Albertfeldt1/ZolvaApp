# Feature Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `free | lite | pro` tier actually change behaviour — a server-enforced weekly chat cap, agent eligibility + tool gating, and Pro-only proactive crons.

**Architecture:** The server (`user_entitlements` via `getEntitlement`) is the source of truth for every gate; the client mirrors gates only for UX. Chat caps reuse the existing `claude_usage_buckets` rate-limit pattern with a new weekly bucket + RPC, enforced at the `chat-run` round-0 boundary. Agent behaviour is gated by skipping free users at `agent-tick` and clamping the resolved policy by tier in the runner. Proactive crons filter their user selection to Pro.

**Tech Stack:** Supabase Edge Functions (Deno/TypeScript), Postgres (plpgsql RPC), React Native (Expo), RevenueCat (`react-native-purchases` / `-ui`). Tests: `deno test` (server pure logic), Jest (client).

**Spec:** `docs/superpowers/specs/2026-06-07-feature-gating-design.md`

---

## File Structure

**Server — new:**
- `supabase/migrations/20260607150000_chat_quota.sql` — weekly bucket CHECK + `check_and_incr_chat_quota` RPC.
- `supabase/functions/_shared/chat-limits.ts` (+ `.test.ts`) — pure tier→weekly-limit mapping.
- `supabase/functions/_shared/agent/tier-policy.ts` (+ `.test.ts`) — pure `clampModeForTier`.
- `supabase/functions/_shared/entitlement-pro.ts` (+ `.test.ts`) — pure `keepProUsers` + IO `proUserIdSet`.

**Server — modified:**
- `supabase/functions/chat-run/index.ts` — quota check after the abuse limiter.
- `supabase/functions/agent-tick/index.ts` — per-user tier read, skip free, pass tier.
- `supabase/functions/_shared/agent/runner.ts` — thread `tier` into `RunInput`/`executeRun`, clamp at the resolve-policy site.
- `supabase/functions/_shared/agent/policy.ts` — (no change; clamp lives in runner so all `resolvePolicy` callers stay untouched).
- `supabase/functions/agent-commitments/index.ts`, `agent-reflect/index.ts`, `agent-memory-followups/index.ts` — filter `selectAgentEnabledUsers` to Pro.

**Client — new:**
- (error class added to existing `src/lib/claude.ts`).

**Client — modified:**
- `src/lib/claude.ts` — `ChatQuotaError` class.
- `src/lib/chat-jobs.ts` — `402` branch in `submitChatJob`.
- `src/lib/hooks.ts` — `useChat` cap state + catch + return field.
- `src/screens/ChatScreen.tsx` — disabled input + upgrade banner on cap.
- `src/screens/SettingsScreen.tsx` — Pro-gate the agent-actions card.

---

## Task 1: Weekly chat-quota bucket + RPC (migration)

**Files:**
- Create: `supabase/migrations/20260607150000_chat_quota.sql`

- [ ] **Step 1: Write the migration**

Reuses `claude_usage_buckets` (from `20260421300000_claude_rate_limit.sql`). The existing CHECK only allows `('minute','day')`, so it must be widened, then add the weekly-quota RPC (increment-first-then-check, same race-safety as `check_and_incr_claude_usage`).

```sql
-- Per-user weekly chat message cap for tier gating (free/lite). Pro is
-- unlimited and never calls this. Reuses claude_usage_buckets with a new
-- 'chat_week' kind so we get the same atomic upsert + PK hot path for free.
--
-- This counts USER MESSAGES (one increment per chat-run round-0), not Claude
-- API calls — a single message can fan out into many claude-proxy tool rounds,
-- which must NOT each consume quota.

alter table claude_usage_buckets
  drop constraint if exists claude_usage_buckets_kind_check;
alter table claude_usage_buckets
  add constraint claude_usage_buckets_kind_check
  check (kind in ('minute', 'day', 'chat_week'));

-- Atomically increment the user's current-week bucket and return whether they
-- are still under p_limit. Week starts Monday 00:00 UTC (date_trunc 'week').
create or replace function check_and_incr_chat_quota(
  p_user_id uuid,
  p_limit int
) returns table (allowed boolean, used int, limit_count int, resets_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_week_start timestamptz := date_trunc('week', v_now);
  v_count int;
begin
  -- Self-only when called with a user JWT; service role (null uid) bypasses.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'user_id mismatch';
  end if;

  insert into claude_usage_buckets (user_id, kind, bucket_start, requests)
  values (p_user_id, 'chat_week', v_week_start, 1)
  on conflict (user_id, kind, bucket_start)
  do update set requests = claude_usage_buckets.requests + 1, updated_at = v_now
  returning requests into v_count;

  return query select
    (v_count <= p_limit),
    v_count,
    p_limit,
    (v_week_start + interval '7 days');
end;
$$;

grant execute on function check_and_incr_chat_quota(uuid, int) to authenticated;
```

- [ ] **Step 2: Verify the SQL parses (lint)**

Run: `grep -c "create or replace function check_and_incr_chat_quota" supabase/migrations/20260607150000_chat_quota.sql`
Expected: `1`

(The RPC itself is verified against the live DB in Task 11's smoke test — it can't be unit-tested without a Postgres instance, matching how `check_and_incr_claude_usage` and the billing webhook were validated.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260607150000_chat_quota.sql
git commit -m "feat(billing): weekly chat-quota bucket + RPC"
```

---

## Task 2: Tier → weekly-limit mapping (pure)

**Files:**
- Create: `supabase/functions/_shared/chat-limits.ts`
- Test: `supabase/functions/_shared/chat-limits.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { chatLimitForTier } from './chat-limits.ts';

Deno.test('free is capped at 50/week', () => {
  assertEquals(chatLimitForTier('free'), 50);
});
Deno.test('lite is capped at 300/week', () => {
  assertEquals(chatLimitForTier('lite'), 300);
});
Deno.test('pro is unlimited (null)', () => {
  assertEquals(chatLimitForTier('pro'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/chat-limits.test.ts`
Expected: FAIL — module not found / `chatLimitForTier` undefined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// supabase/functions/_shared/chat-limits.ts
//
// Weekly chat message caps per tier. Pro is unlimited (null → skip the quota
// RPC entirely). Used by chat-run to gate round-0. The client never needs these
// numbers — it reacts to the server's 402 chat_quota response.
import type { Tier } from './entitlement.ts';

export const CHAT_WEEKLY_LIMITS: Record<'free' | 'lite', number> = {
  free: 50,
  lite: 300,
};

// null = unlimited (pro).
export function chatLimitForTier(tier: Tier): number | null {
  if (tier === 'pro') return null;
  return CHAT_WEEKLY_LIMITS[tier];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/chat-limits.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/chat-limits.ts supabase/functions/_shared/chat-limits.test.ts
git commit -m "feat(billing): tier to weekly chat-limit mapping"
```

---

## Task 3: Enforce the chat cap in chat-run

**Files:**
- Modify: `supabase/functions/chat-run/index.ts` (after the abuse limiter, ~line 122)

- [ ] **Step 1: Add the imports**

At the top of `chat-run/index.ts`, alongside the existing `recordAiUsage` import (~line 21), add:

```typescript
import { getEntitlement } from '../_shared/entitlement-read.ts';
import { chatLimitForTier } from '../_shared/chat-limits.ts';
```

- [ ] **Step 2: Add the quota check**

Immediately AFTER the existing abuse rate-limit block (the `if (!limit?.allowed) { ... return 429 ... }` ending at ~line 122) and BEFORE `let body: ChatRunRequest;` (~line 124), insert:

```typescript
  // Tier message cap (sub-project #2). The abuse limiter above protects the
  // shared API key; this protects the business model. Counts user messages
  // (round-0 only), so claude-proxy tool rounds are NOT charged. Pro skips it.
  const ent = await getEntitlement(authClient, userId);
  const chatLimit = chatLimitForTier(ent.tier);
  if (chatLimit !== null) {
    const { data: quotaRows, error: quotaErr } = await authClient.rpc(
      'check_and_incr_chat_quota',
      { p_user_id: userId, p_limit: chatLimit },
    );
    if (quotaErr) {
      console.error(`[chat-run] chat_quota_check_failed user=${userId} err=${quotaErr.message}`);
      return json({ error: 'chat quota check failed' }, 500);
    }
    const quota = Array.isArray(quotaRows) ? quotaRows[0] : quotaRows;
    if (!quota?.allowed) {
      // 402 (not 429) so the client distinguishes "upgrade to continue" from
      // the transient abuse limiter — the 429 path shows a retry message, this
      // path shows the paywall.
      return new Response(
        JSON.stringify({
          error: 'chat_quota',
          tier: ent.tier,
          used: Number(quota?.used ?? chatLimit),
          limit: chatLimit,
          resets_at: quota?.resets_at ?? null,
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    }
  }
```

- [ ] **Step 3: Typecheck the function**

Run: `deno check supabase/functions/chat-run/index.ts`
Expected: no errors (note: pre-existing remote-import warnings are fine; no NEW type errors).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/chat-run/index.ts
git commit -m "feat(billing): enforce weekly chat cap at chat-run round-0"
```

---

## Task 4: Tier-aware policy clamp (pure)

**Files:**
- Create: `supabase/functions/_shared/agent/tier-policy.ts`
- Test: `supabase/functions/_shared/agent/tier-policy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { clampModeForTier } from './tier-policy.ts';

Deno.test('pro is identity', () => {
  assertEquals(clampModeForTier('pro', 'mail.send_reply', 'auto'), 'auto');
  assertEquals(clampModeForTier('pro', 'cal.create_event', 'auto'), 'auto');
  assertEquals(clampModeForTier('pro', 'nudge.push', 'auto'), 'auto');
});

Deno.test('lite downgrades sends to propose', () => {
  assertEquals(clampModeForTier('lite', 'mail.send_reply', 'auto'), 'propose');
  assertEquals(clampModeForTier('lite', 'mail.send_new', 'auto'), 'propose');
});

Deno.test('lite disables calendar writes and nudges', () => {
  assertEquals(clampModeForTier('lite', 'cal.create_event', 'auto'), 'off');
  assertEquals(clampModeForTier('lite', 'cal.update_event', 'propose'), 'off');
  assertEquals(clampModeForTier('lite', 'cal.rsvp', 'propose'), 'off');
  assertEquals(clampModeForTier('lite', 'nudge.push', 'auto'), 'off');
});

Deno.test('lite leaves read/summarize/draft untouched', () => {
  assertEquals(clampModeForTier('lite', 'mail.summarize', 'auto'), 'auto');
  assertEquals(clampModeForTier('lite', 'mail.draft_reply', 'auto'), 'auto');
  assertEquals(clampModeForTier('lite', 'cal.list_events', 'auto'), 'auto');
});

Deno.test('free disables everything (defensive — free is skipped earlier)', () => {
  assertEquals(clampModeForTier('free', 'mail.summarize', 'auto'), 'off');
  assertEquals(clampModeForTier('free', 'mail.draft_reply', 'auto'), 'off');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/agent/tier-policy.test.ts`
Expected: FAIL — `clampModeForTier` undefined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// supabase/functions/_shared/agent/tier-policy.ts
//
// Clamps a resolved policy mode by subscription tier. Applied AFTER
// resolvePolicy in the runner so it overrides both user overrides and trust
// promotions — a tier ceiling can never be lifted by per-recipient trust.
//
//   pro  → identity (full DEFAULT_POLICY + trust escalation).
//   lite → mail triage (read + propose), but NO auto-execution of any write:
//          sends downgraded to propose; calendar writes + nudges disabled.
//   free → everything off (defensive; free users are skipped at agent-tick
//          eligibility and never reach the runner).
import type { ActionType, PolicyMode } from './types.ts';
import type { Tier } from '../entitlement.ts';

// Lite is calendar-read-only and never sends nudges.
const LITE_DISABLED = new Set<ActionType>([
  'cal.create_event',
  'cal.update_event',
  'cal.rsvp',
  'nudge.push',
]);

// Lite may draft a reply, but it is surfaced for approval, never auto-sent.
const LITE_PROPOSE = new Set<ActionType>([
  'mail.send_reply',
  'mail.send_new',
]);

export function clampModeForTier(
  tier: Tier,
  action: ActionType,
  mode: PolicyMode,
): PolicyMode {
  if (tier === 'pro') return mode;
  if (tier === 'free') return 'off';
  // lite:
  if (LITE_DISABLED.has(action)) return 'off';
  if (LITE_PROPOSE.has(action)) return 'propose';
  return mode;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/agent/tier-policy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tier-policy.ts supabase/functions/_shared/agent/tier-policy.test.ts
git commit -m "feat(billing): tier-aware agent policy clamp"
```

---

## Task 5: Thread tier into the runner + apply the clamp

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts` (RunInput ~162, runAgent ~229, executeRun ~253, resolve-policy site ~361)

- [ ] **Step 1: Add the import**

Near the top of `runner.ts` alongside `import { resolvePolicy } from './policy.ts';` (~line 24), add:

```typescript
import { clampModeForTier } from './tier-policy.ts';
import type { Tier } from '../entitlement.ts';
```

- [ ] **Step 2: Add `tier` to `RunInput`**

Change the `RunInput` interface (~line 162) to:

```typescript
export interface RunInput {
  userId: string;
  trigger: AgentRunTrigger;
  deps: RunnerDeps;
  // Subscription tier. Defaults to 'pro' downstream so proactive callers
  // (reflect/commitments/memory-followups), which are already Pro-gated at
  // selection, need no change. agent-tick passes the real tier.
  tier?: Tier;
}
```

- [ ] **Step 3: Pass tier from runAgent into executeRun**

In `runAgent` (~line 246), change:

```typescript
  return executeRun(userId, trigger, events, deps, mailTriageStrategy);
```

to:

```typescript
  return executeRun(userId, trigger, events, deps, mailTriageStrategy, input.tier ?? 'pro');
```

- [ ] **Step 4: Add the `tier` parameter to executeRun**

Change the `executeRun` signature (~line 253) to add a trailing `tier` param with a Pro default (so the three proactive callers — `runReflect` ~655, `runMemoryFollowup` ~691, `runCommitmentScan` ~706 — compile unchanged):

```typescript
async function executeRun(
  userId: string,
  trigger: AgentRunTrigger,
  events: ClaimedEvent[],
  deps: RunnerDeps,
  strategy: AgentStrategy,
  tier: Tier = 'pro',
): Promise<RunResult> {
```

- [ ] **Step 5: Apply the clamp at the resolve-policy site**

At ~line 361, change:

```typescript
        const policy = resolvePolicy(action, userPolicy, {
          recipient,
          promotions,
        });
        if (policy === 'off') {
```

to:

```typescript
        const policy = clampModeForTier(
          tier,
          action,
          resolvePolicy(action, userPolicy, { recipient, promotions }),
        );
        if (policy === 'off') {
```

- [ ] **Step 6: Typecheck**

Run: `deno check supabase/functions/_shared/agent/runner.ts`
Expected: no NEW errors.

- [ ] **Step 7: Run the existing agent runner tests to confirm no regression**

Run: `deno test supabase/functions/_shared/agent/`
Expected: PASS (existing suite green — clamp defaults to 'pro' so behaviour is unchanged for every current test).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts
git commit -m "feat(billing): thread tier into runner and clamp policy by tier"
```

---

## Task 6: Skip free users at agent-tick + pass tier

**Files:**
- Modify: `supabase/functions/agent-tick/index.ts` (per-user loop ~49)

- [ ] **Step 1: Add the import**

Alongside the existing imports (~line 12), add:

```typescript
import { getEntitlement } from '../_shared/entitlement-read.ts';
```

- [ ] **Step 2: Read tier and skip free in the loop**

Change the loop body (~line 49-53):

```typescript
  for (const uid of userIds) {
    try {
      const deps = buildDeps(serviceClient, uid);
      const r = await runAgent({ userId: uid, trigger, deps });
      results.push({ userId: uid, ...r });
```

to:

```typescript
  for (const uid of userIds) {
    try {
      // Tier gate (sub-project #2): free users never run the agent — even
      // Haiku triage costs money. lite/pro run; the runner clamps lite's
      // write actions to propose/off (see tier-policy.ts).
      const ent = await getEntitlement(serviceClient, uid);
      if (ent.tier === 'free') {
        results.push({ userId: uid, skipped: true, reason: 'tier_free' });
        continue;
      }
      const deps = buildDeps(serviceClient, uid);
      const r = await runAgent({ userId: uid, trigger, deps, tier: ent.tier });
      results.push({ userId: uid, ...r });
```

- [ ] **Step 3: Typecheck**

Run: `deno check supabase/functions/agent-tick/index.ts`
Expected: no NEW errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/agent-tick/index.ts
git commit -m "feat(billing): skip free users at agent-tick, pass tier to runner"
```

---

## Task 7: Pro-only filter for proactive crons (pure + IO)

**Files:**
- Create: `supabase/functions/_shared/entitlement-pro.ts`
- Test: `supabase/functions/_shared/entitlement-pro.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { keepProUsers } from './entitlement-pro.ts';

const users = [
  { userId: 'a', timezone: 'Europe/Copenhagen' },
  { userId: 'b', timezone: 'Europe/Copenhagen' },
  { userId: 'c', timezone: 'Europe/Copenhagen' },
];

Deno.test('keeps only users in the pro set', () => {
  const pro = new Set(['a', 'c']);
  assertEquals(keepProUsers(users, pro).map((u) => u.userId), ['a', 'c']);
});

Deno.test('missing from the set = excluded (free baseline)', () => {
  assertEquals(keepProUsers(users, new Set<string>()).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/entitlement-pro.test.ts`
Expected: FAIL — `keepProUsers` undefined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// supabase/functions/_shared/entitlement-pro.ts
//
// Proactive crons (commitments/reflect/memory-followups) are Pro-only. Split
// into a pure filter (unit-tested) + the IO that fetches the pro id set
// (smoke-tested against the live DB). A missing user_entitlements row means
// free, so only users with an explicit tier='pro' row pass.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function keepProUsers<T extends { userId: string }>(
  users: T[],
  proIds: Set<string>,
): T[] {
  return users.filter((u) => proIds.has(u.userId));
}

export async function proUserIdSet(
  client: SupabaseClient,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await client
    .from('user_entitlements')
    .select('user_id')
    .eq('tier', 'pro')
    .in('user_id', userIds);
  if (error) throw error;
  return new Set((data ?? []).map((r: { user_id: string }) => r.user_id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/entitlement-pro.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/entitlement-pro.ts supabase/functions/_shared/entitlement-pro.test.ts
git commit -m "feat(billing): pro-only user filter helper for proactive crons"
```

---

## Task 8: Apply the Pro filter in the three proactive crons

**Files:**
- Modify: `supabase/functions/agent-reflect/index.ts` (`selectAgentEnabledUsers` ~26-43)
- Modify: `supabase/functions/agent-commitments/index.ts` (`selectAgentEnabledUsers` ~43)
- Modify: `supabase/functions/agent-memory-followups/index.ts` (`selectAgentEnabledUsers` ~28)

Each function has its own near-identical `selectAgentEnabledUsers`. Apply the SAME change in all three.

- [ ] **Step 1: Add the import in each of the three files**

Near the top of each file's imports, add:

```typescript
import { keepProUsers, proUserIdSet } from '../_shared/entitlement-pro.ts';
```

- [ ] **Step 2: Filter to Pro at the end of each `selectAgentEnabledUsers`**

In each file, change the tail of `selectAgentEnabledUsers` from:

```typescript
    out.push({ userId: r.user_id, timezone: r.timezone || 'Europe/Copenhagen' });
  }
  return out;
}
```

to:

```typescript
    out.push({ userId: r.user_id, timezone: r.timezone || 'Europe/Copenhagen' });
  }
  // Proactive behaviours are Pro-only (sub-project #2). Drop non-pro users
  // before any deps build / Claude call.
  const pro = await proUserIdSet(client, out.map((u) => u.userId));
  return keepProUsers(out, pro);
}
```

(Note: `agent-commitments` and `agent-memory-followups` return shapes include `scannedAt`/extra fields — the change is the same; `keepProUsers` is generic over `{ userId }` so it preserves whatever shape each `out` carries. Match each file's existing local variable name if it differs from `out`.)

- [ ] **Step 3: Typecheck the three functions**

Run: `deno check supabase/functions/agent-reflect/index.ts supabase/functions/agent-commitments/index.ts supabase/functions/agent-memory-followups/index.ts`
Expected: no NEW errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/agent-reflect/index.ts supabase/functions/agent-commitments/index.ts supabase/functions/agent-memory-followups/index.ts
git commit -m "feat(billing): gate proactive crons to pro tier"
```

---

## Task 9: Client — ChatQuotaError + 402 handling

**Files:**
- Modify: `src/lib/claude.ts` (add error class next to `ClaudeRateLimitError`)
- Modify: `src/lib/chat-jobs.ts` (`submitChatJob` ~106)

- [ ] **Step 1: Add the `ChatQuotaError` class**

In `src/lib/claude.ts`, find `ClaudeRateLimitError` and add directly after it:

```typescript
// Thrown when the user hit their tier's weekly chat cap (server returns 402
// with error:'chat_quota'). Distinct from ClaudeRateLimitError (transient
// abuse limiter) — this one drives the upgrade paywall, not a retry message.
export class ChatQuotaError extends Error {
  readonly resetsAt: string | null;
  readonly tier: string;
  constructor(resetsAt: string | null, tier: string) {
    super('chat_quota');
    this.name = 'ChatQuotaError';
    this.resetsAt = resetsAt;
    this.tier = tier;
  }
}
```

- [ ] **Step 2: Add the 402 branch in `submitChatJob`**

In `src/lib/chat-jobs.ts`, add `ChatQuotaError` to the import from `./claude` (~line 19-27), then insert a `402` branch in `submitChatJob` immediately BEFORE the existing `if (res.status === 429) {` block (~line 106):

```typescript
  if (res.status === 402) {
    let resetsAt: string | null = null;
    let tier = 'free';
    try {
      const b = (await res.json()) as { resets_at?: string | null; tier?: string };
      resetsAt = b.resets_at ?? null;
      tier = b.tier ?? 'free';
    } catch {
      // fall through with defaults
    }
    throw new ChatQuotaError(resetsAt, tier);
  }
```

- [ ] **Step 3: Verify the import line**

The import block at the top of `chat-jobs.ts` must now include `ChatQuotaError`:

```typescript
import {
  ChatQuotaError,
  ClaudeConfigError,
  ClaudeRateLimitError,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeSystemBlock,
  type ClaudeToolSchema,
  type ClaudeToolUse,
} from './claude';
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "claude.ts|chat-jobs.ts" || echo "no new errors in changed files"`
Expected: `no new errors in changed files`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude.ts src/lib/chat-jobs.ts
git commit -m "feat(billing): surface 402 chat_quota as ChatQuotaError"
```

---

## Task 10: Client — useChat cap state

**Files:**
- Modify: `src/lib/hooks.ts` (`useChat` ~5003; catch ~5561; return ~5594)

- [ ] **Step 1: Import `ChatQuotaError`**

Ensure `ChatQuotaError` is imported in `hooks.ts`. It imports from `./claude` already (e.g. `ClaudeRateLimitError` at ~line 33) — add `ChatQuotaError` to that import list.

- [ ] **Step 2: Add cap state inside useChat**

Just after `const [messages, setMessages] = useState<ChatMessage[]>([]);` (~line 5004), add:

```typescript
  // Weekly chat cap (sub-project #2). Set when the server returns 402
  // chat_quota; the screen disables input + shows the upgrade banner until
  // resetsAt. `null` = not capped.
  const [chatCap, setChatCap] = useState<{ resetsAt: string | null } | null>(null);
```

- [ ] **Step 3: Handle the error in the catch**

In the `.catch((err: Error) => { ... })` block (~line 5561), change:

```typescript
        .catch((err: Error) => {
          if (__DEV__ && getPrivacyFlag('anon-reports')) {
            console.warn('[useChat] Claude request failed:', err.message);
          }
          const text = err instanceof ClaudeRateLimitError ? err.message : CHAT_ERROR_TEXT;
          setMessages((cur) => [
            ...cur,
            { id: `e-${Date.now()}`, from: 'zolva', text, createdAt: new Date().toISOString() },
          ]);
        })
```

to:

```typescript
        .catch((err: Error) => {
          if (__DEV__ && getPrivacyFlag('anon-reports')) {
            console.warn('[useChat] Claude request failed:', err.message);
          }
          // Tier cap: don't post a generic error bubble — flip cap state so the
          // screen shows the upgrade banner + disables the input instead.
          if (err instanceof ChatQuotaError) {
            setChatCap({ resetsAt: err.resetsAt });
            return;
          }
          const text = err instanceof ClaudeRateLimitError ? err.message : CHAT_ERROR_TEXT;
          setMessages((cur) => [
            ...cur,
            { id: `e-${Date.now()}`, from: 'zolva', text, createdAt: new Date().toISOString() },
          ]);
        })
```

- [ ] **Step 4: Expose cap state + a clearer on the hook return**

Change the return (~line 5594):

```typescript
  return { data: messages, typing, loading: false, error: null as Error | null, send, clear, sendDraft };
```

to:

```typescript
  return {
    data: messages,
    typing,
    loading: false,
    error: null as Error | null,
    send,
    clear,
    sendDraft,
    chatCap,
    clearChatCap: () => setChatCap(null),
  };
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "hooks.ts" | grep -v "5037" || echo "no new errors in hooks.ts"`
Expected: `no new errors in hooks.ts` (ignore the known pre-existing TS2322 at hooks.ts:5037 per project memory).

- [ ] **Step 6: Commit**

```bash
git add src/lib/hooks.ts
git commit -m "feat(billing): useChat exposes weekly cap state"
```

---

## Task 11: Client — ChatScreen cap UX (hard block)

**Files:**
- Modify: `src/screens/ChatScreen.tsx` (useChat consumer ~64; input ~725; dock ~415-471)
- Test: `src/screens/__tests__/ChatScreen.cap.test.tsx` (create; match the repo's existing screen-test location/pattern)

- [ ] **Step 1: Write the failing test**

Mirror the nearest existing ChatScreen/screen test for render setup (providers, mocks). The behavioural assertions:

```tsx
// src/screens/__tests__/ChatScreen.cap.test.tsx
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { ChatScreen } from '../ChatScreen';
import * as hooks from '../../lib/hooks';
import * as paywall from '../../lib/paywall';

jest.mock('../../lib/paywall');

function mockChat(overrides: Partial<ReturnType<typeof hooks.useChat>>) {
  jest.spyOn(hooks, 'useChat').mockReturnValue({
    data: [], typing: false, loading: false, error: null,
    send: jest.fn(), clear: jest.fn(), sendDraft: jest.fn(),
    chatCap: null, clearChatCap: jest.fn(),
    ...overrides,
  } as ReturnType<typeof hooks.useChat>);
}

it('shows the upgrade banner and disables input when capped', () => {
  mockChat({ chatCap: { resetsAt: new Date(Date.now() + 86_400_000).toISOString() } });
  const { getByText, getByLabelText } = render(<ChatScreen />);
  expect(getByText(/Opgrader til Pro/i)).toBeTruthy();
  expect(getByLabelText('chat-input').props.editable).toBe(false);
});

it('opens the paywall when the upgrade button is tapped', () => {
  const spy = jest.spyOn(paywall, 'presentPaywallIfNeeded').mockResolvedValue(false);
  mockChat({ chatCap: { resetsAt: new Date(Date.now() + 86_400_000).toISOString() } });
  const { getByText } = render(<ChatScreen />);
  fireEvent.press(getByText(/Opgrader til Pro/i));
  expect(spy).toHaveBeenCalledWith('pro');
});

it('is not capped when chatCap is null', () => {
  mockChat({ chatCap: null });
  const { queryByText, getByLabelText } = render(<ChatScreen />);
  expect(queryByText(/Opgrader til Pro/i)).toBeNull();
  expect(getByLabelText('chat-input').props.editable).not.toBe(false);
});
```

(If the existing ChatScreen tests render via a different harness/props, copy that harness here — keep the three assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/screens/__tests__/ChatScreen.cap.test.tsx`
Expected: FAIL — no `accessibilityLabel="chat-input"` / no upgrade banner yet.

- [ ] **Step 3: Consume cap state + compute `capped`**

In `ChatScreen.tsx`, at the `useChat()` consumer (~line 64), destructure the new fields and derive a live `capped` boolean:

```tsx
  const { data, typing, send, clear, sendDraft, chatCap, clearChatCap } = useChat();
  const capped = React.useMemo(() => {
    if (!chatCap) return false;
    if (!chatCap.resetsAt) return true;
    return Date.now() < new Date(chatCap.resetsAt).getTime();
  }, [chatCap]);

  // Auto-clear the cap once the reset time passes while the screen is open.
  React.useEffect(() => {
    if (!chatCap?.resetsAt) return;
    const ms = new Date(chatCap.resetsAt).getTime() - Date.now();
    if (ms <= 0) { clearChatCap(); return; }
    const id = setTimeout(() => clearChatCap(), Math.min(ms, 2_147_483_000));
    return () => clearTimeout(id);
  }, [chatCap, clearChatCap]);
```

- [ ] **Step 4: Add the `accessibilityLabel` + disable the input**

At the chat `TextInput` (~line 725), add `accessibilityLabel="chat-input"` and gate `editable`:

```tsx
            accessibilityLabel="chat-input"
            editable={!capped}
```

(Keep all other existing props on that input.)

- [ ] **Step 5: Render the upgrade banner in the dock**

Add the import at the top of `ChatScreen.tsx`:

```tsx
import { presentPaywallIfNeeded } from '../lib/paywall';
```

In the dock area (~line 415-471), render the banner above the input row when `capped`:

```tsx
        {capped ? (
          <View
            style={{
              marginHorizontal: spacing.md,
              marginBottom: spacing.sm,
              padding: spacing.md,
              borderRadius: radius.card,
              backgroundColor: t.line,
              gap: spacing.xs,
            }}
          >
            <Text style={{ ...type.body, color: t.ink, fontFamily: fonts.uiBold }}>
              Du har brugt dine beskeder i denne uge
            </Text>
            <Text style={{ ...type.small, color: t.ink3 }}>
              Opgrader til Pro for ubegrænset chat.
            </Text>
            <Pressable
              onPress={() => { void presentPaywallIfNeeded('pro').then((ok) => { if (ok) clearChatCap(); }); }}
              style={({ pressed }) => ({
                alignSelf: 'flex-start',
                marginTop: spacing.xs,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.sm,
                borderRadius: radius.pill,
                backgroundColor: t.ink,
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <Text style={{ ...type.body, color: '#FFFFFF', fontFamily: fonts.uiBold }}>
                Opgrader til Pro
              </Text>
            </Pressable>
          </View>
        ) : null}
```

(Use the spacing/`radius`/`type`/`fonts`/`t` tokens already imported in this file — match the names used elsewhere in ChatScreen; the snippet above mirrors the SettingsScreen upgrade button at SettingsScreen.tsx:2026-2045.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/screens/__tests__/ChatScreen.cap.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/screens/ChatScreen.tsx src/screens/__tests__/ChatScreen.cap.test.tsx
git commit -m "feat(billing): hard-block chat UI on weekly cap with upgrade banner"
```

---

## Task 12: Client — Pro-gate the agent-actions card in Settings

**Files:**
- Modify: `src/screens/SettingsScreen.tsx` (agent-actions card ~2069-2083)

The card holds `ZolvaHandlingerSection` (master agent enable — needed by **lite** for triage), `AgentActionPolicySection` + `TrustPromotionsSection` (autonomous-write controls — **Pro-only**). `entitlement` + `entitlementLoading` are already in scope (SettingsScreen.tsx:1364).

- [ ] **Step 1: Add a small Pro-upsell row component**

Near the other local section components in `SettingsScreen.tsx`, add:

```tsx
function ProUpsellRow({ label }: { label: string }) {
  return (
    <View style={{ paddingHorizontal: 20, paddingVertical: 16, gap: 8 }}>
      <Text style={{ ...type.body, color: t.ink, fontFamily: fonts.uiBold }}>{label}</Text>
      <Text style={{ ...type.small, color: t.ink3 }}>
        Autonome handlinger kræver Pro.
      </Text>
      <Pressable
        onPress={() => { void presentPaywallIfNeeded('pro'); }}
        style={({ pressed }) => ({
          alignSelf: 'flex-start', marginTop: 4,
          paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
          borderRadius: radius.pill, backgroundColor: t.ink, opacity: pressed ? 0.75 : 1,
        })}
      >
        <Text style={{ ...type.body, color: '#FFFFFF', fontFamily: fonts.uiBold }}>Opgrader til Pro</Text>
      </Pressable>
    </View>
  );
}
```

Add the import at the top of `SettingsScreen.tsx` (it currently imports `presentPaywall, presentCustomerCenter` at line 16):

```tsx
import { presentPaywall, presentPaywallIfNeeded, presentCustomerCenter } from '../lib/paywall';
```

(Use whatever `t`/`type`/`fonts`/`spacing`/`radius` access pattern this file already uses inside components — match `ZolvaHandlingerSection`'s neighbours.)

- [ ] **Step 2: Gate the card contents by tier**

Change the card body (~line 2079-2083):

```tsx
                <ZolvaHandlingerSection />
                <AgentActionPolicySection />
                <TrustPromotionsSection />
```

to:

```tsx
                {entitlementLoading ? null : entitlement.tier === 'free' ? (
                  // Free: the agent never runs — upsell the whole card.
                  <ProUpsellRow label="Zolva-handlinger" />
                ) : entitlement.tier === 'lite' ? (
                  // Lite: triage on/off is available; autonomous policy is Pro-only.
                  <>
                    <ZolvaHandlingerSection />
                    <ProUpsellRow label="Autonome handlinger" />
                  </>
                ) : (
                  // Pro: everything.
                  <>
                    <ZolvaHandlingerSection />
                    <AgentActionPolicySection />
                    <TrustPromotionsSection />
                  </>
                )}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "SettingsScreen.tsx" || echo "no new errors in SettingsScreen.tsx"`
Expected: `no new errors in SettingsScreen.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(billing): pro-gate autonomous agent controls in settings"
```

---

## Task 13: Full verification + deploy

**Files:** none (verification + ops)

- [ ] **Step 1: Run the full server test suite**

Run: `deno test supabase/functions/`
Expected: PASS — all existing tests plus the new `chat-limits`, `tier-policy`, `entitlement-pro` suites.

- [ ] **Step 2: Run the full client test suite**

Run: `npx jest`
Expected: PASS — including the new ChatScreen cap test.

- [ ] **Step 3: Typecheck the whole client**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: only the 3 KNOWN pre-existing errors (hooks.ts:5037 TS2322 + 2× NotificationsScreen LucideIcon) — NO new errors.

- [ ] **Step 4: Apply the migration (server-first, per project convention)**

Apply `20260607150000_chat_quota.sql` out-of-band (the migration history is drifted — do NOT `supabase db push`). Use the Supabase MCP `apply_migration` or the dashboard SQL editor against project `sjkhfkatmeqtsrysixop`. Verify:

```sql
select proname from pg_proc where proname = 'check_and_incr_chat_quota';
-- expect 1 row
select conname, pg_get_constraintdef(oid) from pg_constraint
  where conname = 'claude_usage_buckets_kind_check';
-- expect the CHECK to include 'chat_week'
```

- [ ] **Step 5: Smoke-test the quota RPC against the live DB**

For test user `5d9ef13e…` (re-resolve live per project memory), call the RPC past the limit and confirm `allowed` flips, then clean up:

```sql
-- as service role
select * from check_and_incr_chat_quota('<TEST_UUID>'::uuid, 2); -- allowed=true used=1
select * from check_and_incr_chat_quota('<TEST_UUID>'::uuid, 2); -- allowed=true used=2
select * from check_and_incr_chat_quota('<TEST_UUID>'::uuid, 2); -- allowed=false used=3, resets_at set
delete from claude_usage_buckets where user_id = '<TEST_UUID>'::uuid and kind = 'chat_week';
```

- [ ] **Step 6: Deploy the edge functions (server-first)**

Deploy each changed function with `--no-verify-jwt` (service/secret-authed; chat-run already runs that way), project-ref `sjkhfkatmeqtsrysixop`:

```bash
supabase functions deploy chat-run --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
supabase functions deploy agent-tick --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
supabase functions deploy agent-commitments --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
supabase functions deploy agent-reflect --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
supabase functions deploy agent-memory-followups --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
```

- [ ] **Step 7: Regression check — the agent still acts for Pro**

Confirm a Pro user still gets auto-sends (the clamp is identity for pro). Trigger an on-demand `agent-tick` for the Pro test user and confirm an `agent_runs` row + expected actions land (mirrors the four-wiring-spots regression watch from the scheduling/renewals build). Confirm a Lite user's run produces proposals only (no auto-send, no cal write, no nudge) and a free user is skipped (`reason: 'tier_free'` in the response).

- [ ] **Step 8: Client OTA from main**

After merging to `main`, OTA per project convention: `eas update --branch production`. (Native rebuild is NOT required — no new native modules; `react-native-purchases-ui` already shipped with the billing foundation.)

- [ ] **Step 9: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(billing): feature-gating verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** chat cap (Tasks 1-3, 9-11), agent eligibility (Task 6), lite policy clamp (Tasks 4-5), proactive Pro-gate (Tasks 7-8), client UI gates — chat (Task 11) + settings (Task 12), testing (each task + Task 13). All spec sections mapped.
- **No Sonnet model change** (out of scope per spec) — confirmed: no edits to `DEFAULT_MODEL`.
- **Type consistency:** `clampModeForTier(tier, action, mode)`, `chatLimitForTier(tier)`, `keepProUsers(users, set)` / `proUserIdSet(client, ids)`, `ChatQuotaError(resetsAt, tier)`, hook field `chatCap` / `clearChatCap` — names used identically across producing and consuming tasks. `Tier` imported from `_shared/entitlement.ts` (server) and the client reads tier from `useEntitlement()`.
- **402 vs 429:** quota uses 402 specifically so it does NOT collide with the existing 429 abuse-limit path in `submitChatJob`.
