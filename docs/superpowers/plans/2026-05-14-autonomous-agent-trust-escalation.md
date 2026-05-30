# Autonomous Agent — Trust Escalation Implementation Plan

> **⚠️ STALE-REFS NOTE (added 2026-05-30):** This plan was written 2026-05-14, before the agent pipeline was actually repaired (commits `af2bde6`/`6158915`/`2a9a10f`). Its file line-numbers (`runner.ts:74-79`, `:153`, `:213`, etc.), the `resolvePolicy` signature, and the tool catalog have all shifted since. Notably `MAX_TOOL_ROUNDS` is now 6, the runner checks budget before claiming, and `mail_archive`/`mail_label`/`mail_flag_important` were retired. Re-verify every code reference against current `main` before executing (see memory `project_agent_pipeline_repaired.md`). The design/data-model is still sound; only the integration points need re-tracing.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user approves a proposed `mail.send_reply` ≥ 3 times for the same recipient, surface a one-tap offer in the Today feed, the Settings history, **and the iOS home-screen widget** to auto-promote that `(action_type, recipient)` pattern to `auto`. Tap reverts available from Settings.

**Architecture:** A new `trust_offers` table tracks both the *offer* state and the *active promotion* state through a single `status` column (`pending → accepted → reverted` or `pending → dismissed`). After a successful approval, `agent-approve` counts the user's lifetime approvals for `(action_type, payload->>'to')` from `proposed_actions`; if the count crosses 3 and no live promotion or pending offer exists, it inserts a `pending` row. The Today feed renders pending rows as a distinct card with Yes/No. The runner's `resolvePolicy()` learns a third lookup layer: per-recipient `trust_offers.status='accepted'` rows now override `user_agent_policy` for `mail.send_reply`. Settings gains a "Auto-sender" subsection listing accepted promotions with a revert pressable.

The iOS home-screen widget (`targets/widget/`) gets a parallel surface: the widget snapshot grows an optional `pendingTrustOffer` field (schema stays at 1 — Swift `Codable` ignores unknown keys by default, so old widget binaries see `nil` and render the existing context row, while new binaries render the offer card). When the field is present the widget swaps its top context row to a tappable Approve/Dismiss card. Approve/Dismiss are iOS 17+ interactive-widget `Button(intent:)` controls backed by two `AppIntent`s (`AcceptTrustOfferIntent`, `DismissTrustOfferIntent`) that POST to a new edge function `trust-offer-decide`. This mirrors the existing widget/voice-intents pattern (`plugins/voice-intents/IntentActionClient.swift` → `widget-action` edge fn).

**Tech Stack:** Supabase Postgres (RLS), Deno edge functions (`agent-approve`, `trust-offer-decide`, `_shared/agent/policy.ts`, `_shared/agent/runner.ts`), React Native (`TodayScreen.tsx`, `SettingsScreen.tsx`, `AgentActionPolicySection.tsx`), Swift (`WidgetKit` + `AppIntents` in `targets/widget/`, snapshot bridge in `src/lib/widget-snapshot.ts`). Spec §5.3 + §6.4.

**Scope (v1 — what ships in this plan):**
- Detection + offer creation in `agent-approve` (server only, no cron).
- Policy resolver consults per-recipient promotions for `mail.send_reply` only. Other action types are out of scope.
- Today feed pending-offer card.
- Settings history list of accepted promotions with revert.
- iOS home-screen widget surfaces the newest pending offer with tap-to-decide buttons (iOS 17+); pre-17 falls back to a deep link.

**Explicitly OUT of scope:**
- Per-domain ("anyone @company.com") patterns — v1 is exact email match only.
- Sender-pattern promotions for other action types (`mail.archive` etc.) — same mechanism would generalize, but `mail.send_reply` is the demo target per memory.
- Auto-dismissal of stale offers — pending rows live until decided.
- Widget revert UI — revert lives only in app Settings; widget shows pending offers only.
- Android widget — Zolva is iOS-only.

---

## File Structure

**Create:**
- `supabase/migrations/20260514120000_trust_offers.sql` — table + RLS + index
- `supabase/functions/_shared/agent/trust.ts` — pure logic for resolvePolicy override + threshold check
- `supabase/functions/_shared/agent/trust.test.ts` — unit tests for above
- `supabase/functions/trust-offer-decide/index.ts` — JWT-auth POST endpoint for Swift AppIntent → DB write
- `src/components/TrustOfferCard.tsx` — Today feed pending-offer card
- `src/components/TrustPromotionsSection.tsx` — Settings list of accepted promotions
- `targets/widget/TrustOfferIntent.swift` — `AcceptTrustOfferIntent` + `DismissTrustOfferIntent` AppIntents (widget target)
- `targets/widget/TrustOfferActionClient.swift` — POST client + retry-on-401 (mirrors `IntentActionClient`)
- `targets/widget/SupabaseSession.swift` — re-exports / lightweight re-impl of keychain reader for widget target (only if main-app file isn't accessible; see Task 9 Step 1)

**Modify:**
- `supabase/functions/_shared/agent/policy.ts` — extend `resolvePolicy` to consult promotions for `mail.send_reply`
- `supabase/functions/_shared/agent/runner.ts` — load active promotions, pass to resolvePolicy for send_reply path
- `supabase/functions/agent-approve/index.ts` — after successful execute, count + maybe insert pending offer
- `src/screens/TodayScreen.tsx` — fetch + render trust offers above proposals list
- `src/screens/SettingsScreen.tsx` — insert TrustPromotionsSection inside the existing "Zolva-handlinger" block
- `src/lib/widget-snapshot.ts` — bump schema to 2, add `pendingTrustOffer` field, populate from a Supabase read
- `targets/widget/SnapshotPayload.swift` — bump `expectedSchema` to 2, add `PendingTrustOffer` codable
- `targets/widget/index.swift` — swap context row to TrustOfferCardView when `payload.pendingTrustOffer != nil`

---

## Data Model

```sql
create table public.trust_offers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  action_type   text not null,
  recipient     text not null,
  status        text not null check (status in ('pending','accepted','dismissed','reverted')),
  approval_count int not null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  reverted_at   timestamptz
);
-- One active offer per (user, action_type, recipient). Pending OR accepted both occupy the slot.
create unique index trust_offers_active_uniq
  on public.trust_offers (user_id, action_type, recipient)
  where status in ('pending','accepted');
create index trust_offers_user_status_idx
  on public.trust_offers (user_id, status, created_at desc);
```

Lifecycle:
- `pending` — offer surfaced in Today; user has not decided. Only one pending row per slot (uniq index).
- `accepted` — promotion active; resolvePolicy returns `auto`. Visible in Settings.
- `dismissed` — user tapped "No"; treat as terminal so we don't re-offer the same slot.
- `reverted` — user tapped revert in Settings; treat as terminal too (a future approval streak can create a brand-new offer because the uniq index excludes `reverted`/`dismissed`).

Note on terminal states: both `dismissed` and `reverted` exit the uniq partial index, which means after 3 more approvals a new `pending` row CAN appear. This is deliberate — user behavior may evolve. If we later want suppression, we'd add a "respect-user-no" check by reading recent history.

---

### Task 1: Add the trust_offers migration

**Files:**
- Create: `supabase/migrations/20260514120000_trust_offers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260514120000_trust_offers.sql

-- Trust-escalation v1: track per-(user, action_type, recipient) approvals
-- and surface a one-tap offer to auto-promote in the Today feed. See spec
-- 2026-05-11-autonomous-background-actions §5.3 + §6.4.

create table if not exists public.trust_offers (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  action_type    text not null,
  recipient      text not null,
  status         text not null check (status in ('pending','accepted','dismissed','reverted')),
  approval_count int not null,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  reverted_at    timestamptz
);

-- Active offer = pending OR accepted. Both occupy the slot so we don't
-- double-prompt or stack two competing promotions for the same recipient.
create unique index if not exists trust_offers_active_uniq
  on public.trust_offers (user_id, action_type, recipient)
  where status in ('pending','accepted');

create index if not exists trust_offers_user_status_idx
  on public.trust_offers (user_id, status, created_at desc);

alter table public.trust_offers enable row level security;

-- Users read their own offers (Today feed + Settings).
create policy "owner-select-trust-offers" on public.trust_offers
  for select to authenticated
  using (auth.uid() = user_id);

-- Users update their own offers (decide pending, revert accepted). The
-- check clause prevents flipping someone else's row.
create policy "owner-update-trust-offers" on public.trust_offers
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Inserts are service-role-only (agent-approve writes pending rows). No
-- INSERT policy → default-deny for authenticated.
```

- [ ] **Step 2: Apply the migration locally**

Run: `supabase db push --linked` (or `supabase db reset` if local dev DB)

Expected: migration applied, `trust_offers` exists. Inspect via `\d trust_offers` in psql.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260514120000_trust_offers.sql
git commit -m "feat(agent): trust_offers table for auto-promotion offers"
```

---

### Task 2: Pure logic — resolveTrustPolicy + shouldOfferPromotion

**Files:**
- Create: `supabase/functions/_shared/agent/trust.ts`
- Create: `supabase/functions/_shared/agent/trust.test.ts`

This task introduces two pure functions exercised only by tests. No Supabase calls. Real DB integration happens in Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

```typescript
// supabase/functions/_shared/agent/trust.test.ts

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  resolveTrustPolicy,
  shouldOfferPromotion,
  TRUST_OFFER_THRESHOLD,
} from './trust.ts';

Deno.test('resolveTrustPolicy: accepted promotion for matching recipient returns auto', () => {
  const promotions = [
    { action_type: 'mail.send_reply', recipient: 'mom@example.com' },
  ];
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'mom@example.com', promotions),
    'auto',
  );
});

Deno.test('resolveTrustPolicy: case-insensitive recipient match', () => {
  const promotions = [
    { action_type: 'mail.send_reply', recipient: 'Mom@Example.com' },
  ];
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'mom@EXAMPLE.com', promotions),
    'auto',
  );
});

Deno.test('resolveTrustPolicy: no promotion returns null (caller falls back to user_agent_policy)', () => {
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'mom@example.com', []),
    null,
  );
});

Deno.test('resolveTrustPolicy: different recipient does NOT match', () => {
  const promotions = [
    { action_type: 'mail.send_reply', recipient: 'mom@example.com' },
  ];
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'dad@example.com', promotions),
    null,
  );
});

Deno.test('resolveTrustPolicy: different action_type does NOT match', () => {
  const promotions = [
    { action_type: 'mail.archive', recipient: 'mom@example.com' },
  ];
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'mom@example.com', promotions),
    null,
  );
});

Deno.test('shouldOfferPromotion: threshold exactly hit, no prior offer → true', () => {
  assertEquals(shouldOfferPromotion(TRUST_OFFER_THRESHOLD, null), true);
});

Deno.test('shouldOfferPromotion: above threshold, no prior offer → true', () => {
  assertEquals(shouldOfferPromotion(TRUST_OFFER_THRESHOLD + 5, null), true);
});

Deno.test('shouldOfferPromotion: below threshold → false', () => {
  assertEquals(shouldOfferPromotion(TRUST_OFFER_THRESHOLD - 1, null), false);
});

Deno.test('shouldOfferPromotion: pending offer already exists → false (no double-prompt)', () => {
  assertEquals(shouldOfferPromotion(10, 'pending'), false);
});

Deno.test('shouldOfferPromotion: accepted offer already exists → false (already auto)', () => {
  assertEquals(shouldOfferPromotion(10, 'accepted'), false);
});

Deno.test('shouldOfferPromotion: dismissed offer present → true (user may have changed mind)', () => {
  assertEquals(shouldOfferPromotion(10, 'dismissed'), true);
});

Deno.test('shouldOfferPromotion: reverted offer present → true (user may have changed mind)', () => {
  assertEquals(shouldOfferPromotion(10, 'reverted'), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd supabase/functions && deno test _shared/agent/trust.test.ts --allow-env`

Expected: FAIL — module `./trust.ts` does not exist.

- [ ] **Step 3: Implement trust.ts**

```typescript
// supabase/functions/_shared/agent/trust.ts
//
// Trust-escalation pure logic. Two responsibilities:
//   1. resolveTrustPolicy() — given the user's active promotions and a
//      candidate (action_type, recipient), decide whether the per-
//      recipient override pins the policy to `auto`. Returns null when
//      no promotion applies, so the runner falls back to user_agent_policy.
//   2. shouldOfferPromotion() — given lifetime approval count for a slot
//      and the status of the most recent offer for that slot (or null),
//      decide whether agent-approve should insert a new pending offer.

import type { ActionType } from './types.ts';

export const TRUST_OFFER_THRESHOLD = 3;

export interface TrustPromotion {
  action_type: string;
  recipient: string;
}

export function resolveTrustPolicy(
  actionType: ActionType,
  recipient: string,
  promotions: TrustPromotion[],
): 'auto' | null {
  const target = recipient.toLowerCase();
  for (const p of promotions) {
    if (p.action_type === actionType && p.recipient.toLowerCase() === target) {
      return 'auto';
    }
  }
  return null;
}

// `latestOfferStatus` is the status of the most recent offer row for the
// same (user, action_type, recipient) slot — or null if no row exists.
// Active slots ('pending' | 'accepted') suppress new offers; terminal
// rows ('dismissed' | 'reverted') do NOT, so a renewed approval streak
// can create a fresh offer.
export function shouldOfferPromotion(
  approvalCount: number,
  latestOfferStatus: 'pending' | 'accepted' | 'dismissed' | 'reverted' | null,
): boolean {
  if (approvalCount < TRUST_OFFER_THRESHOLD) return false;
  if (latestOfferStatus === 'pending' || latestOfferStatus === 'accepted') return false;
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd supabase/functions && deno test _shared/agent/trust.test.ts --allow-env`

Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/trust.ts \
        supabase/functions/_shared/agent/trust.test.ts
git commit -m "feat(agent): trust-escalation pure logic — resolveTrustPolicy + threshold gate"
```

---

### Task 3: Wire active promotions into the runner's policy resolver

The runner needs to consult `trust_offers.status='accepted'` for the specific `(action_type, recipient)` of a `mail.send_reply` call before falling back to `user_agent_policy`.

**Files:**
- Modify: `supabase/functions/_shared/agent/policy.ts`
- Modify: `supabase/functions/_shared/agent/runner.ts:74-79` (RunnerDeps), `runner.ts:153` (load step), `runner.ts:213` (call site)
- Modify: `supabase/functions/_shared/agent/runner.test.ts` — extend tests to cover the new branch
- Modify: `supabase/functions/agent-tick/index.ts` — supply real `loadActivePromotions` dep

- [ ] **Step 1: Extend resolvePolicy to accept optional recipient + promotions**

Edit `supabase/functions/_shared/agent/policy.ts`:

```typescript
import {
  ActionType,
  DEFAULT_POLICY,
  PolicyMode,
  UserPolicyRow,
} from './types.ts';
import { resolveTrustPolicy, type TrustPromotion } from './trust.ts';

export function resolvePolicy(
  actionType: ActionType,
  rows: UserPolicyRow[],
  context?: { recipient?: string; promotions?: TrustPromotion[] },
): PolicyMode {
  // Trust-escalation override: per-recipient accepted promotions take
  // precedence over the action-level user_agent_policy. Only applied when
  // both a recipient AND a promotions list are passed by the caller —
  // existing callers without context get the original behavior.
  if (context?.recipient && context.promotions) {
    const trust = resolveTrustPolicy(actionType, context.recipient, context.promotions);
    if (trust === 'auto') return 'auto';
  }
  const row = rows.find((r) => r.action_type === actionType);
  return row?.mode ?? DEFAULT_POLICY[actionType];
}
```

- [ ] **Step 2: Update the existing policy.test.ts to cover the new path**

Read `supabase/functions/_shared/agent/policy.test.ts` first, then append:

```typescript
import { resolveTrustPolicy as _ } from './trust.ts'; // ensure module is wired

Deno.test('resolvePolicy: accepted promotion overrides user_agent_policy=propose', () => {
  const rows = [{ user_id: 'u', action_type: 'mail.send_reply' as const, mode: 'propose' as const }];
  const promotions = [{ action_type: 'mail.send_reply', recipient: 'mom@example.com' }];
  assertEquals(
    resolvePolicy('mail.send_reply', rows, { recipient: 'mom@example.com', promotions }),
    'auto',
  );
});

Deno.test('resolvePolicy: no matching promotion falls through to user_agent_policy', () => {
  const rows = [{ user_id: 'u', action_type: 'mail.send_reply' as const, mode: 'propose' as const }];
  const promotions = [{ action_type: 'mail.send_reply', recipient: 'dad@example.com' }];
  assertEquals(
    resolvePolicy('mail.send_reply', rows, { recipient: 'mom@example.com', promotions }),
    'propose',
  );
});

Deno.test('resolvePolicy: empty promotions + no row falls back to DEFAULT_POLICY', () => {
  assertEquals(
    resolvePolicy('mail.send_reply', [], { recipient: 'x@y.com', promotions: [] }),
    'propose',
  );
});
```

If `policy.test.ts` doesn't already import `assertEquals`, add `import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';` at the top.

- [ ] **Step 3: Run policy tests**

Run: `cd supabase/functions && deno test _shared/agent/policy.test.ts --allow-env`

Expected: all existing tests pass + 3 new tests pass.

- [ ] **Step 4: Extend RunnerDeps with loadActivePromotions**

In `supabase/functions/_shared/agent/runner.ts`, after the existing Phase 3.1 safety deps (around line 79), add:

```typescript
  // Phase 4 trust-escalation: accepted per-recipient promotions.
  // Loaded once per run alongside loadUserPolicy.
  loadActivePromotions: (userId: string) => Promise<Array<{ action_type: string; recipient: string }>>;
```

Then at line 153 (just after `const userPolicy = await deps.loadUserPolicy(userId);`), add:

```typescript
    const promotions = await deps.loadActivePromotions(userId);
```

Then at the `resolvePolicy(action, userPolicy)` call site (currently line 213), change to:

```typescript
        const recipient =
          action === 'mail.send_reply' && typeof input.to === 'string'
            ? input.to
            : undefined;
        const policy = resolvePolicy(action, userPolicy, {
          recipient,
          promotions,
        });
```

- [ ] **Step 5: Update runner.test.ts stubs**

Every test that builds `deps` needs `loadActivePromotions`. In `runner.test.ts`, find the test setup helper(s) and add to the default stub:

```typescript
loadActivePromotions: async () => [],
```

Then add ONE new test exercising the promotion-overrides-propose path:

```typescript
Deno.test('runAgent: mail.send_reply with active promotion auto-sends without user policy=auto', async () => {
  const deps = makeDefaultDeps(); // existing helper — adapt to your setup
  deps.loadUserPolicy = async () => [
    { user_id: 'u1', action_type: 'mail.send_reply', mode: 'propose' },
  ];
  deps.loadActivePromotions = async () => [
    { action_type: 'mail.send_reply', recipient: 'mom@example.com' },
  ];
  // ... wire claimEvents to emit a mail event, loadThreadBriefs to return one
  //     thread, callClaudeTurn to return a mail.send_reply tool_use with
  //     input.to='mom@example.com', and assert executeTool was called with
  //     opts.policy='auto'.
});
```

(Match the helper style already used in `runner.test.ts:288` for the policy=auto test.)

- [ ] **Step 6: Run runner tests**

Run: `cd supabase/functions && deno test _shared/agent/runner.test.ts --allow-env`

Expected: all existing tests pass + 1 new test passes.

- [ ] **Step 7: Wire the real Supabase loader in agent-tick/index.ts**

Find where `agent-tick/index.ts` builds the `RunnerDeps` object and add:

```typescript
loadActivePromotions: async (userId) => {
  const { data } = await client
    .from('trust_offers')
    .select('action_type, recipient')
    .eq('user_id', userId)
    .eq('status', 'accepted');
  return data ?? [];
},
```

- [ ] **Step 8: Run the whole agent test suite**

Run: `cd supabase/functions && deno test _shared/agent/ --allow-env`

Expected: all tests pass (was 103 + ~14 new = ~117 green).

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/agent/policy.ts \
        supabase/functions/_shared/agent/policy.test.ts \
        supabase/functions/_shared/agent/runner.ts \
        supabase/functions/_shared/agent/runner.test.ts \
        supabase/functions/agent-tick/index.ts
git commit -m "feat(agent): runner honors trust_offers.accepted as per-recipient policy override"
```

---

### Task 4: agent-approve writes pending offers when threshold is hit

**Files:**
- Modify: `supabase/functions/agent-approve/index.ts` — append a step after the post-execute write succeeds

The detection logic uses two reads from `proposed_actions`:
1. Count of `status='executed'` rows with the same `(user_id, action_type, payload->>'to')` — i.e. all prior approvals for this recipient.
2. The most recent `trust_offers` row status (if any) for this slot — to decide whether to suppress.

Both reads are cheap (indexed). We do this only when `action_type='mail.send_reply'` and the execution succeeded.

- [ ] **Step 1: Add the trust import at the top of agent-approve/index.ts**

After the existing `import` block, add:

```typescript
import { shouldOfferPromotion } from '../_shared/agent/trust.ts';
```

- [ ] **Step 2: Add the helper at the bottom of agent-approve/index.ts**

```typescript
async function maybeCreateTrustOffer(
  client: SupabaseClient,
  userId: string,
  actionType: string,
  recipient: string,
): Promise<void> {
  if (actionType !== 'mail.send_reply') return;
  if (!recipient) return;

  // Lifetime count of approved sends to this recipient. PostgREST exposes
  // JSONB extraction via the ->> operator inside filter values; supabase-js
  // forwards the literal string.
  const { count, error: countErr } = await client
    .from('proposed_actions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .eq('status', 'executed')
    .eq('payload->>to', recipient);
  if (countErr) {
    console.error('[agent-approve] trust count error', countErr);
    return;
  }

  // Most recent offer for this slot.
  const { data: latest, error: latestErr } = await client
    .from('trust_offers')
    .select('status')
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .eq('recipient', recipient)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    console.error('[agent-approve] trust latest error', latestErr);
    return;
  }

  if (!shouldOfferPromotion(count ?? 0, latest?.status ?? null)) return;

  const { error: insertErr } = await client.from('trust_offers').insert({
    user_id: userId,
    action_type: actionType,
    recipient,
    status: 'pending',
    approval_count: count,
  });
  // Uniq partial index can race with a concurrent approval — swallow 23505.
  if (insertErr && insertErr.code !== '23505') {
    console.error('[agent-approve] trust insert error', insertErr);
  }
}
```

- [ ] **Step 3: Call it after the proposal flips to 'executed'**

In `agent-approve/index.ts`, immediately before `return new Response(JSON.stringify({ ok: true, sent: true })...)` (currently line 164), add:

```typescript
  // Trust escalation: ≥3 approvals for the same recipient + no live offer
  // → surface a one-tap "auto from now on?" card in Today. Best-effort:
  // failures are logged but don't block the success response.
  try {
    const toAddr = typeof payload.to === 'string' ? payload.to : '';
    await maybeCreateTrustOffer(client, userId, claimed.action_type, toAddr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-approve] trust escalation check failed', msg);
  }
```

- [ ] **Step 4: Deploy the function**

Run: `supabase functions deploy agent-approve --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt`

(The `--no-verify-jwt` is required per `project_supabase_asymmetric_jwt.md`.)

- [ ] **Step 5: Manual smoke from psql**

```sql
-- Seed: pretend the user has already approved 3 sends to mom@example.com.
insert into proposed_actions (id, user_id, run_id, action_type, payload, preview, status, executed_at)
values
  (gen_random_uuid(), '<your-user-id>', null, 'mail.send_reply',
   '{"provider":"google","to":"mom@example.com","thread_id":"t1","draft_id":"d1","draft_hash":"h1","preview_text":"x"}',
   '{}', 'executed', now()),
  (gen_random_uuid(), '<your-user-id>', null, 'mail.send_reply',
   '{"provider":"google","to":"mom@example.com","thread_id":"t2","draft_id":"d2","draft_hash":"h2","preview_text":"x"}',
   '{}', 'executed', now()),
  (gen_random_uuid(), '<your-user-id>', null, 'mail.send_reply',
   '{"provider":"google","to":"mom@example.com","thread_id":"t3","draft_id":"d3","draft_hash":"h3","preview_text":"x"}',
   '{}', 'executed', now());
```

Then invoke agent-approve on a fresh pending row for `mom@example.com` and confirm a `trust_offers` row with `status='pending'` and `approval_count >= 4` appears.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/agent-approve/index.ts
git commit -m "feat(agent): emit trust_offers after 3rd recipient approval"
```

---

### Task 5: Today feed — render pending trust offers

**Files:**
- Create: `src/components/TrustOfferCard.tsx`
- Modify: `src/screens/TodayScreen.tsx` — fetch + render

- [ ] **Step 1: Build TrustOfferCard.tsx**

```typescript
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors } from '../theme';

export interface TrustOffer {
  id: string;
  action_type: string;
  recipient: string;
  approval_count: number;
}

interface Props {
  offer: TrustOffer;
  onDecided: () => void;
}

export function TrustOfferCard({ offer, onDecided }: Props) {
  const [busy, setBusy] = useState(false);

  const decide = useCallback(async (status: 'accepted' | 'dismissed') => {
    setBusy(true);
    try {
      await supabase
        .from('trust_offers')
        .update({ status, decided_at: new Date().toISOString() })
        .eq('id', offer.id);
      onDecided();
    } finally {
      setBusy(false);
    }
  }, [offer.id, onDecided]);

  return (
    <View style={styles.card} accessibilityLabel={`trust-offer-${offer.id}`}>
      <Text style={styles.title}>Vil du have at jeg sender automatisk?</Text>
      <Text style={styles.body}>
        Du har godkendt mine svar til <Text style={styles.bold}>{offer.recipient}</Text> {offer.approval_count} gange.
        Skal jeg sende dem direkte fremover?
      </Text>
      <View style={styles.row}>
        <Pressable
          onPress={() => decide('dismissed')}
          disabled={busy}
          style={[styles.btn, styles.btnGhost]}
          accessibilityLabel="trust-offer-no"
        >
          <Text style={styles.btnGhostText}>Nej tak</Text>
        </Pressable>
        <Pressable
          onPress={() => decide('accepted')}
          disabled={busy}
          style={[styles.btn, styles.btnPrimary]}
          accessibilityLabel="trust-offer-yes"
        >
          <Text style={styles.btnPrimaryText}>Ja, send automatisk</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.fg2 ?? '#F4F1EC',
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 20,
    marginVertical: 8,
    gap: 10,
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '600', color: colors.ink },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  btn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  btnGhost: { backgroundColor: '#0000' },
  btnGhostText: { color: colors.fg3, fontSize: 14 },
  btnPrimary: { backgroundColor: colors.ink },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
```

- [ ] **Step 2: Fetch pending offers in TodayScreen.tsx**

Read `src/screens/TodayScreen.tsx` to find the existing query that loads proposed_actions / agent_actions for the feed. Add a sibling query for trust offers (top of file or wherever the data fetches live):

```typescript
const { data: trustOffers } = await supabase
  .from('trust_offers')
  .select('id, action_type, recipient, approval_count')
  .eq('user_id', user.id)
  .eq('status', 'pending')
  .order('created_at', { ascending: false });
```

Store in state. Render `<TrustOfferCard>` rows above the existing pending-proposals section. On `onDecided`, refetch (or filter the local state list).

If the screen uses a single combined list with section labels, render trust offers as their own section with header "Tilbud" so they don't visually collide with action proposals.

- [ ] **Step 3: Manual smoke**

With a seeded `trust_offers` row from Task 4 step 4, open the Today tab in the app. Expected: card renders. Tap "Ja" → row disappears, DB shows `status='accepted'`, `decided_at` set. Tap "Nej tak" → row disappears, DB shows `status='dismissed'`.

- [ ] **Step 4: Commit**

```bash
git add src/components/TrustOfferCard.tsx src/screens/TodayScreen.tsx
git commit -m "feat(agent): Today feed surfaces pending trust-escalation offers"
```

---

### Task 6: Settings — accepted promotions list with revert

**Files:**
- Create: `src/components/TrustPromotionsSection.tsx`
- Modify: `src/screens/SettingsScreen.tsx` — insert the new section inside the "Zolva-handlinger" block (near `<AgentActionPolicySection />`)

- [ ] **Step 1: Build TrustPromotionsSection.tsx**

```typescript
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { colors } from '../theme';

interface Promotion {
  id: string;
  action_type: string;
  recipient: string;
  decided_at: string | null;
}

export function TrustPromotionsSection() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from('trust_offers')
      .select('id, action_type, recipient, decided_at')
      .eq('user_id', user.id)
      .eq('status', 'accepted')
      .order('decided_at', { ascending: false });
    setRows((data ?? []) as Promotion[]);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const revert = useCallback(async (id: string) => {
    await supabase
      .from('trust_offers')
      .update({ status: 'reverted', reverted_at: new Date().toISOString() })
      .eq('id', id);
    setRows((r) => r.filter((row) => row.id !== id));
  }, []);

  if (!user || loading || rows.length === 0) return null;

  return (
    <View style={styles.section} accessibilityLabel="trust-promotions">
      <Text style={styles.title}>Auto-sender</Text>
      <Text style={styles.body}>
        Zolva sender automatisk svar til disse modtagere. Tryk for at fjerne.
      </Text>
      {rows.map((p) => (
        <View key={p.id} style={styles.row}>
          <Text style={styles.rowLabel}>{p.recipient}</Text>
          <Pressable
            onPress={() => revert(p.id)}
            style={styles.revertBtn}
            accessibilityLabel={`revert-${p.id}`}
          >
            <Text style={styles.revertText}>Fjern</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingVertical: 16, gap: 8 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  rowLabel: { color: colors.ink, fontSize: 15, flexShrink: 1 },
  revertBtn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, backgroundColor: '#0001' },
  revertText: { color: colors.ink, fontSize: 13 },
});
```

- [ ] **Step 2: Mount in SettingsScreen.tsx**

Find the existing `<AgentActionPolicySection />` mount and add `<TrustPromotionsSection />` directly below it (or above — both belong in the "Zolva-handlinger" block).

- [ ] **Step 3: Manual smoke**

With a seeded `trust_offers` row at `status='accepted'`, open Settings → expand "Zolva-handlinger" → confirm the row appears with the recipient email. Tap "Fjern" → row disappears, DB shows `status='reverted'`, `reverted_at` set. Confirm the next agent run for the same recipient now writes a `proposed_actions` row again (no longer auto-promoted).

- [ ] **Step 4: Commit**

```bash
git add src/components/TrustPromotionsSection.tsx src/screens/SettingsScreen.tsx
git commit -m "feat(agent): Settings shows accepted trust promotions with revert"
```

---

### Task 7: Edge function `trust-offer-decide`

The Swift AppIntent can't call `supabase-js` — it needs a JSON POST endpoint. This task adds a small JWT-authed edge function the widget calls, mirroring the existing `widget-action` pattern.

**Files:**
- Create: `supabase/functions/trust-offer-decide/index.ts`
- Create: `supabase/functions/trust-offer-decide/deno.json` (copy from `agent-approve/deno.json` if present, else import-map equivalent)

- [ ] **Step 1: Write index.ts**

```typescript
// supabase/functions/trust-offer-decide/index.ts
//
// JWT-authed endpoint called by the iOS widget AppIntents
// (AcceptTrustOfferIntent / DismissTrustOfferIntent) to transition a
// trust_offers row from 'pending' to 'accepted' or 'dismissed'. Mirrors
// the agent-approve / widget-action pattern.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const userId = await authenticatedUserId(req);
  if (!userId) return new Response('unauthorized', { status: 401 });

  let body: { offer_id?: string; decision?: 'accepted' | 'dismissed' };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const offerId = body.offer_id;
  const decision = body.decision;
  if (!offerId || (decision !== 'accepted' && decision !== 'dismissed')) {
    return new Response('offer_id + decision required', { status: 400 });
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Atomic transition: pending → accepted|dismissed, only if owned by caller.
  const { data: claimed, error } = await client
    .from('trust_offers')
    .update({ status: decision, decided_at: new Date().toISOString() })
    .eq('id', offerId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id, status')
    .maybeSingle();
  if (error) {
    console.error('[trust-offer-decide] update error', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }
  if (!claimed) {
    // Already decided or not owned — idempotent success from widget's POV.
    return new Response(JSON.stringify({ ok: true, alreadyDecided: true }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});
```

- [ ] **Step 2: Local test via curl**

Run: `supabase functions serve trust-offer-decide`, then in another shell:

```bash
JWT=$(supabase auth login... | jq -r .access_token)   # use a real session token
curl -i -X POST http://localhost:54321/functions/v1/trust-offer-decide \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"offer_id":"<seeded-pending-id>","decision":"accepted"}'
```

Expected: `200 {"ok":true}`. Re-running returns `200 {"ok":true,"alreadyDecided":true}`.

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy trust-offer-decide --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/trust-offer-decide/
git commit -m "feat(agent): trust-offer-decide edge fn for widget AppIntents"
```

---

### Task 8: Widget snapshot — schema v2 with pendingTrustOffer

Both sides of the snapshot contract change together. TS writer is in `src/lib/widget-snapshot.ts`; Swift reader is in `targets/widget/SnapshotPayload.swift`. Bumping schema from 1 to 2 means a transitional period where old widget binaries reject new snapshots — that's fine (the widget falls through to placeholder, same as a stale snapshot).

**Files:**
- Modify: `src/lib/widget-snapshot.ts`
- Modify: `targets/widget/SnapshotPayload.swift`
- Modify: caller(s) of `buildSnapshotFromState` to fetch the pending offer and pass it through

- [ ] **Step 1: Extend widget-snapshot.ts (additive, schema stays at 1)**

Edit `src/lib/widget-snapshot.ts`. Keep `WIDGET_SNAPSHOT_SCHEMA = 1` — we are NOT bumping. Adding an optional field is a non-breaking change because Swift's `JSONDecoder` ignores unknown keys by default. Old widget binaries (no `pendingTrustOffer` in their struct) read the new payload, drop the field, and render the existing context.

```typescript
export type PendingTrustOffer = {
  id: string;
  actionType: string;   // e.g. "mail.send_reply"
  recipient: string;    // e.g. "mom@example.com"
  approvalCount: number;
};

export type SnapshotPayload = {
  schema: number;
  generatedAt: string;
  morningBrief: { headline: string } | null;
  eveningBrief: { headline: string } | null;
  todayEvents: SnapshotEvent[];
  chatPrompt: string;
  pendingTrustOffer: PendingTrustOffer | null;
};

export type BuildSnapshotInput = {
  now: Date;
  morningBrief: { headline: string } | null;
  eveningBrief: { headline: string } | null;
  events: Array<{ id: string; start: Date; end: Date; title: string }>;
  pendingTrustOffer: PendingTrustOffer | null;
};
```

Update `buildSnapshotFromState` to copy `pendingTrustOffer` through:

```typescript
return {
  schema: WIDGET_SNAPSHOT_SCHEMA,
  generatedAt: input.now.toISOString(),
  morningBrief: input.morningBrief,
  eveningBrief: input.eveningBrief,
  todayEvents: today,
  chatPrompt: '',
  pendingTrustOffer: input.pendingTrustOffer,
};
```

- [ ] **Step 2: Update the snapshot caller to fetch the pending offer**

Find where `buildSnapshotFromState` is called (search: `rg "buildSnapshotFromState\\(" src/`). At that call site, before invoking it, fetch:

```typescript
const { data: trustRows } = await supabase
  .from('trust_offers')
  .select('id, action_type, recipient, approval_count')
  .eq('user_id', user.id)
  .eq('status', 'pending')
  .order('created_at', { ascending: false })
  .limit(1);
const pendingTrustOffer = trustRows?.[0]
  ? {
      id: trustRows[0].id,
      actionType: trustRows[0].action_type,
      recipient: trustRows[0].recipient,
      approvalCount: trustRows[0].approval_count,
    }
  : null;
```

Pass `pendingTrustOffer` into `BuildSnapshotInput`.

- [ ] **Step 3: Update SnapshotPayload.swift (additive — leave `expectedSchema = 1`)**

Edit `targets/widget/SnapshotPayload.swift`. Do NOT change `expectedSchema`. Just add the new struct and the optional field:

```swift
struct PendingTrustOffer: Codable {
  let id: String
  let actionType: String
  let recipient: String
  let approvalCount: Int
}

struct SnapshotPayload: Codable {
  let schema: Int
  let generatedAt: Date
  let morningBrief: BriefHeadline?
  let eveningBrief: BriefHeadline?
  let todayEvents: [SnapshotEvent]
  let chatPrompt: String
  let pendingTrustOffer: PendingTrustOffer?
}
```

Note: keys map to JSON case as Swift property name. Both writer and reader emit/consume camelCase (the existing `morningBrief`/`eveningBrief` already do), so `pendingTrustOffer`/`actionType`/`approvalCount` flow through unchanged. Swift `JSONDecoder` ignores unknown keys by default, so the writer can roll out independently of the new widget binary.

- [ ] **Step 4: Verify decoding manually**

Build the widget extension (Xcode), then in a debug build write a JSON snapshot with schema=2 to the App Group via the existing snapshot-write path. Confirm the widget no longer falls through to placeholder.

- [ ] **Step 5: Commit**

```bash
git add src/lib/widget-snapshot.ts \
        targets/widget/SnapshotPayload.swift \
        <snapshot-caller-file>
git commit -m "feat(widget): carry pending trust offer in snapshot (additive)"
```

---

### Task 9: Swift AppIntents — Accept + Dismiss

Interactive widgets (iOS 17+) call `AppIntent`s when buttons are tapped. The intents need to live in (or be visible to) the widget extension target. The widget target currently doesn't import `AppIntents`; this task introduces it.

**Files:**
- Create: `targets/widget/TrustOfferIntent.swift`
- Create: `targets/widget/TrustOfferActionClient.swift`
- Maybe-create: `targets/widget/SupabaseSession.swift` — only if the existing `plugins/voice-intents/SupabaseSession.swift` is in the main-app target and not shareable. If both targets are configured to include `plugins/voice-intents/*.swift`, skip this step. Verify in Xcode → widget target Build Phases → Compile Sources.

- [ ] **Step 1: Confirm SupabaseSession reachability**

Open Xcode → widget extension target → Build Phases → Compile Sources. If `SupabaseSession.swift` and `SupabaseAuthClient.swift` are NOT in the list, either (a) add them to the widget target's membership in the right-hand Inspector, OR (b) duplicate them under `targets/widget/`. (a) is preferred — single source of truth.

- [ ] **Step 2: Write TrustOfferActionClient.swift**

```swift
// targets/widget/TrustOfferActionClient.swift
import Foundation

enum TrustOfferActionError: Error {
  case unauthorized
  case recoverable(reason: String)
}

@available(iOS 16.0, *)
enum TrustOfferActionClient {
  static let projectRef = "sjkhfkatmeqtsrysixop"
  static let path = "/functions/v1/trust-offer-decide"

  static func decide(offerId: String, decision: String) async throws {
    let accessToken = try SupabaseSession.readAccessToken()
    do {
      try await postOnce(offerId: offerId, decision: decision, jwt: accessToken)
    } catch TrustOfferActionError.unauthorized {
      let newToken = try await SupabaseAuthClient.refresh()
      try await postOnce(offerId: offerId, decision: decision, jwt: newToken)
    }
  }

  private static func postOnce(offerId: String, decision: String, jwt: String) async throws {
    var req = URLRequest(url: URL(string: "https://\(projectRef).supabase.co\(path)")!)
    req.httpMethod = "POST"
    req.timeoutInterval = 6
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
    req.httpBody = try JSONEncoder().encode(Body(offer_id: offerId, decision: decision))

    let (_, response): (Data, URLResponse)
    do {
      (_, response) = try await URLSession.shared.data(for: req)
    } catch {
      throw TrustOfferActionError.recoverable(reason: "network: \(error.localizedDescription)")
    }
    guard let http = response as? HTTPURLResponse else {
      throw TrustOfferActionError.recoverable(reason: "no http response")
    }
    if http.statusCode == 401 { throw TrustOfferActionError.unauthorized }
    guard http.statusCode == 200 else {
      throw TrustOfferActionError.recoverable(reason: "HTTP \(http.statusCode)")
    }
  }

  private struct Body: Encodable {
    let offer_id: String
    let decision: String
  }
}
```

- [ ] **Step 3: Write TrustOfferIntent.swift**

```swift
// targets/widget/TrustOfferIntent.swift
import AppIntents
import WidgetKit
import Foundation

@available(iOS 17.0, *)
struct AcceptTrustOfferIntent: AppIntent {
  static var title: LocalizedStringResource = "Acceptér Zolva-tilbud"
  static var description = IntentDescription("Lad Zolva sende svar automatisk til denne modtager fremover.")
  static var isDiscoverable = false  // widget-internal, not Shortcuts-exposed

  @Parameter(title: "Offer ID")
  var offerId: String

  init() {}
  init(offerId: String) { self.offerId = offerId }

  func perform() async throws -> some IntentResult {
    try await TrustOfferActionClient.decide(offerId: offerId, decision: "accepted")
    WidgetCenter.shared.reloadAllTimelines()
    return .result()
  }
}

@available(iOS 17.0, *)
struct DismissTrustOfferIntent: AppIntent {
  static var title: LocalizedStringResource = "Afvis Zolva-tilbud"
  static var description = IntentDescription("Afvis tilbuddet — Zolva fortsætter med at spørge.")
  static var isDiscoverable = false

  @Parameter(title: "Offer ID")
  var offerId: String

  init() {}
  init(offerId: String) { self.offerId = offerId }

  func perform() async throws -> some IntentResult {
    try await TrustOfferActionClient.decide(offerId: offerId, decision: "dismissed")
    WidgetCenter.shared.reloadAllTimelines()
    return .result()
  }
}
```

- [ ] **Step 4: Build widget target in Xcode**

Cmd-B on the widget scheme. Expected: compiles clean. Resolve any "target membership" warnings for `SupabaseSession`/`SupabaseAuthClient` per Step 1.

- [ ] **Step 5: Commit**

```bash
git add targets/widget/TrustOfferIntent.swift targets/widget/TrustOfferActionClient.swift
git commit -m "feat(widget): AppIntents for trust-offer Accept/Dismiss"
```

---

### Task 10: Widget view — Trust Offer card

The card replaces the existing `contextRow` content when `payload.pendingTrustOffer != nil`. Two `Button(intent:)` rows on iOS 17+; a `Link` to `zolva://settings` fallback on iOS 16. Card shows recipient + a single line of body copy.

**Files:**
- Modify: `targets/widget/index.swift`

- [ ] **Step 1: Add the trust-offer branch to contextRow**

Edit the `contextRow` view builder in `MediumWidgetView`. Add a new branch FIRST (it has priority over briefs / meeting nudges — the user needs to see this offer before any other content):

```swift
@ViewBuilder
private var contextRow: some View {
  if entry.isStale || entry.payload == nil {
    staleState
  } else if let offer = entry.payload?.pendingTrustOffer {
    trustOfferState(offer)
  } else if let brief = morningBriefHeadline {
    briefState(headline: brief)
  } else if let nudge = currentMeetingNudge {
    meetingState(nudge)
  } else if let evening = eveningBriefHeadline {
    eveningState(headline: evening)
  } else if let next = nextEvent {
    nextEventState(next)
  } else {
    chatOnlyContext
  }
}
```

- [ ] **Step 2: Add the trustOfferState view**

Append in the `// MARK: - Context block` section:

```swift
private func trustOfferState(_ offer: PendingTrustOffer) -> some View {
  VStack(alignment: .leading, spacing: 6) {
    Text("Send auto til \(offer.recipient)?")
      .font(.headline)
      .lineLimit(2)
    Text("Du har godkendt \(offer.approvalCount) svar her.")
      .font(.caption)
      .foregroundStyle(.secondary)
    if #available(iOS 17.0, *) {
      HStack(spacing: 6) {
        Button(intent: AcceptTrustOfferIntent(offerId: offer.id)) {
          Text("Ja").font(.caption).fontWeight(.semibold)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.mini)

        Button(intent: DismissTrustOfferIntent(offerId: offer.id)) {
          Text("Nej tak").font(.caption)
        }
        .buttonStyle(.bordered)
        .controlSize(.mini)
      }
      .padding(.top, 2)
    } else {
      Link(destination: URL(string: "zolva://today")!) {
        Text("Åbn for at svare").font(.caption).foregroundStyle(.blue)
      }
      .padding(.top, 2)
    }
  }
}
```

- [ ] **Step 3: Add an Xcode preview**

Append in the `#if DEBUG` block at the bottom of `index.swift`:

```swift
#Preview("Trust Offer", as: .systemMedium) {
  ZolvaMediumWidget()
} timeline: {
  SnapshotEntry(
    date: Date(),
    payload: SnapshotPayload(
      schema: 1,
      generatedAt: Date(),
      morningBrief: nil,
      eveningBrief: nil,
      todayEvents: [],
      chatPrompt: "",
      pendingTrustOffer: PendingTrustOffer(
        id: "offer-1",
        actionType: "mail.send_reply",
        recipient: "mom@example.com",
        approvalCount: 4
      )
    ),
    isStale: false
  )
}
```

Note: every other `#Preview` payload constructor now needs `pendingTrustOffer: nil` added — Swift's `Codable` struct requires all fields at the init call site even though it's optional. The existing previews ("Placeholder", "Stale", "Morning Brief", "Meeting Nudge", "Evening Recap", "Next Event", "Chat Only") all instantiate `SnapshotPayload` directly. Add `pendingTrustOffer: nil` to each.

- [ ] **Step 4: Run the previews in Xcode**

Open `targets/widget/index.swift` in Xcode → preview canvas → cycle through previews. Expected: "Trust Offer" shows the new card with Ja/Nej tak buttons; every other preview renders unchanged.

- [ ] **Step 5: Device smoke test**

1. Seed a `trust_offers` row at `status='pending'` for your user (or trigger the threshold via Task 4's psql snippet).
2. Force a snapshot rebuild (kill + reopen the app, or wait for the next scheduled rebuild).
3. Long-press the widget on the home screen → it should refresh and show the Trust Offer card.
4. Tap "Ja" → widget reloads to next state (likely morning brief / chat prompt). DB row goes to `status='accepted'`.
5. The next agent run for the same recipient should now auto-send.

- [ ] **Step 6: Commit**

```bash
git add targets/widget/index.swift
git commit -m "feat(widget): render pending trust-offer card with interactive Ja/Nej tak"
```

---

## End-to-end verification

After all ten tasks:

1. **DB state**: `select * from trust_offers where user_id = '<test-user>' order by created_at desc;` shows the full lifecycle.
2. **Agent test suite**: `cd supabase/functions && deno test _shared/agent/ --allow-env` — all green, count went from ~103 to ~117.
3. **Live flow — app side**: send yourself a "can we meet?" mail; approve the resulting proposal 3 times in a row (or use seeded data). The 3rd approval should make the Today feed show a TrustOfferCard. Tap Ja → the next reply to the same recipient should land directly in their inbox (proposed_actions skipped). Open Settings → "Auto-sender" row visible → tap Fjern → confirm next reply is back to propose.
4. **Live flow — widget side (iOS 17+)**: with a pending offer present, the widget on the home screen shows the Trust Offer card. Tap Ja → DB flips to `accepted`, widget reloads to next state. Tap Nej tak → DB flips to `dismissed`, widget reloads.

---

## Deploy + ship

After all commits land on the feature branch:

1. Merge to `main` (per `project_build_from_main.md`).
2. Apply the migration to prod:
   ```bash
   supabase db push --linked
   ```
3. Deploy edge functions (per `project_client_server_pr_split.md` — server first):
   ```bash
   supabase functions deploy agent-approve agent-tick trust-offer-decide \
     --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
   ```
4. OTA the React Native client:
   ```bash
   eas update --branch production --message "feat: trust escalation v1"
   ```
5. **Native widget update requires a full EAS build + App Store submission** (OTA does not ship Swift changes). The snapshot change is additive — old widget binaries see the new payload, drop the unknown `pendingTrustOffer` key, and keep rendering the existing context row. Users on the old binary won't see the widget card until they update; the in-app Today + Settings surfaces still work via OTA.
   ```bash
   eas build --platform ios --profile production
   # then submit via App Store Connect
   ```

---

## Memory updates after shipping

When this lands, append to `~/.claude/projects/-Users-albertfeldt-ZolvaApp/memory/`:

- Update `project_phase4_next_pickup.md` — remove trust escalation from the remainder list; note that the per-recipient promotion mechanism exists and could be generalized to other action types.
- Create `project_autonomous_agent_trust_escalation.md` — record the schema (trust_offers + status state machine), the policy-resolver hook point, and the seeded-test approach for future debugging.
