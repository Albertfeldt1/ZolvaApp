# Feature Gating (free | lite | pro) — Design

**Date:** 2026-06-07
**Sub-project:** #2 of the "real billing" effort (after billing-foundation, before forced-win onboarding #4 and paywall polish #3).
**Status:** spec — awaiting user review before plan.

## Problem

Billing foundation (sub-project #1) is live: entitlements `free | lite | pro` are
recorded via RevenueCat → webhook → `user_entitlements`, readable client-side
(`useEntitlement()`) and server-side (`getEntitlement(client, userId)` in
`supabase/functions/_shared/entitlement-read.ts`, free when no row). **But nothing
enforces the tier yet — a Pro user gets exactly the same app as a free user.**
This sub-project wires the entitlement into the chat, the agent, and the proactive
cron functions so the tier actually changes behaviour.

## Tier feature split

| Capability | Free | Lite (49 DKK/mo) | Pro (99/mo, 990/yr) |
|---|---|---|---|
| Chat (Haiku) | 50 msgs/week | 300 msgs/week | unlimited |
| Daily brief | — | ✅ | ✅ |
| Mail triage agent (read + propose) | — | ✅ | ✅ |
| Calendar read | — | ✅ | ✅ |
| Memory | — | ✅ | ✅ |
| Autonomous draft + **send** | — | — | ✅ |
| Calendar **writes** + scheduling | — | — | ✅ |
| Proactive agent (commitments, reflect, memory-followups, nudges) | — | — | ✅ |

Notes:
- **Chat model is Haiku for all tiers.** The only chat gate is the weekly message
  count. (Decided 2026-06-07: gate purely by message count; no Sonnet-for-Pro
  model upgrade in this sub-project.)
- "Read + propose" for Lite = the agent may summarize and surface a *draft* in the
  Today feed for the user to approve, but never auto-sends, never writes the
  calendar, never sends nudges.

## Architecture

The server is the source of truth for every gate (the client can be bypassed).
The client mirrors the gate only for UX (disable input, show the paywall).

### 1. Chat message cap

**Storage / RPC.** Mirror the existing abuse limiter
(`supabase/migrations/20260421300000_claude_rate_limit.sql`,
`check_and_incr_claude_usage` / `claude_usage_buckets`). Add a new RPC
`check_and_incr_chat_quota(p_user_id uuid, p_limit int)`:

- Bucket on a **weekly** window: `bucket_start = date_trunc('week', now())` (UTC,
  Monday start), `kind = 'chat_week'` in `claude_usage_buckets` (reuse the table).
- Increment-first-then-check (same race-safe pattern as the existing RPC).
- Returns `{ allowed boolean, used int, limit int, resets_at timestamptz }`
  where `resets_at = bucket_start + interval '7 days'`.

**Enforcement point.** `supabase/functions/chat-run/index.ts` only — round 0 is the
one-per-user-message boundary. (Every user turn enters at chat-run; `claude-proxy`
only handles tool-continuation rounds 1..N, so counting there would over-charge
tool-heavy turns.) `claude-proxy`'s existing abuse limiter is left unchanged.

Flow in chat-run, after JWT/userId (~line 99) and before the existing rate-limit
RPC (~line 103):

1. `const ent = await getEntitlement(serviceClient, userId)`.
2. `if (ent.tier === 'pro')` → skip the quota check (unlimited).
3. Else `limit = ent.tier === 'lite' ? 300 : 50`; call
   `check_and_incr_chat_quota(userId, limit)`.
4. If `!allowed` → respond `402` with body
   `{ error: 'chat_quota', tier, used, limit, resets_at }`. (402, not 429, so the
   client distinguishes the upgrade-paywall path from the transient abuse limiter.)

Limits live in one shared constant module so client + server agree:
`CHAT_WEEKLY_LIMITS = { free: 50, lite: 300 }` (pro = unlimited / omitted).

**Client UX (hard block).** `src/screens/ChatScreen.tsx`:
- The chat send path (`useChat` in `src/lib/hooks.ts`) surfaces a `429 chat_quota`
  as a typed error carrying `resets_at`.
- On that error: set a `chatCapped` state, disable the input
  (`editable={false}` at ChatScreen ~line 725), and render a banner in the dock
  area: "Du har brugt dine beskeder i denne uge — Opgrader til Pro", wired to
  `presentPaywallIfNeeded('pro')` from `src/lib/paywall.ts`.
- Re-enable when `now >= resets_at` (re-check on screen focus / app foreground).
- No live "X left" counter (hard block was chosen over soft-warn).

### 2. Agent eligibility + tool gating by tier

**Eligibility (`supabase/functions/agent-tick/index.ts`).** Per-user, read
`getEntitlement`:
- `free` → skip the user entirely (covers both the cron path via
  `selectEligibleUserIds` in `_shared/agent/build-deps.ts` and the on-demand
  single-user path). Record a skipped result with `reason: 'tier_free'`.
- `lite` / `pro` → run.

**Tool gating (the tier-aware policy clamp).** The agent's write/auto behaviour is
governed by `DEFAULT_POLICY` and `ACTION_DEFAULT_MODE` in
`_shared/agent/types.ts`, with dispatch in `_shared/agent/tools/dispatch.ts`.
Adding/removing a tool touches the known "four wiring spots"
(prompt.ts tool set, dispatch case, DEFAULT_POLICY, ACTION_DEFAULT_MODE) — we are
**not** adding tools, we are **clamping** existing ones by tier:

- Introduce `clampPolicyForTier(tier, policy)` (pure, unit-tested) applied where
  the per-user policy is resolved before the runner executes.
- `lite`, per-action (no auto-execution of any write):
  - `mail.send_reply` → **downgrade to `propose`** (draft is surfaced in Today
    for approval, never auto-sent).
  - `cal.create_event`, `cal.update_event` → **disable** (Lite is calendar-read-
    only per the tier table).
  - `nudge.push` → **disable** (proactive, Pro-only).
  - Any future write/auto action defaults to **disable** unless it has a
    user-facing propose value.
  - Mail-read, calendar-read, summarize, and draft remain available.
- `pro`: unchanged (full `DEFAULT_POLICY` / trust escalation).
- `free`: never reaches here (skipped at eligibility).

The clamp is the single chokepoint — dispatch.ts does not need per-case tier
branches.

### 3. Proactive cron gating

`agent-commitments`, `agent-reflect`, `agent-memory-followups` are **Pro-only**.
Each selects users via `selectAgentEnabledUsers` (`agent_enabled = true`). Add a
`tier = 'pro'` filter to that selection query (join `user_entitlements`; treat a
missing row as free → excluded) so deps never build for non-pro users. This is a
single shared change if the three functions share the selector, otherwise the
same filter in each.

### 4. Client UI gates (minimum for #2)

- Chat cap → paywall (above).
- Settings agent controls (enable toggle, autonomous/policy picker): when a
  `free`/`lite` user taps a Pro-only control, call `presentPaywallIfNeeded('pro')`
  instead of enabling. Read tier via `useEntitlement()`.

Broad "surface the paywall at every Pro touchpoint" + upsell copy is **#3**, not
this sub-project.

## Out of scope (explicitly)

- No Sonnet-for-Pro model upgrade (gate by message count only).
- No forced-win onboarding run, no trial-urgency nudge (that is #4).
- No paywall visual/copy changes (that is #3).
- No production key swap / App Review (ship-time, last).

## Testing

**Deno (server):**
- `check_and_incr_chat_quota`: under limit → allowed + count rises; at limit →
  last one allowed; over → `allowed=false` with correct `resets_at`; new week →
  resets. (Mirror the existing rate-limit test style.)
- tier → weekly-limit mapping (free=50, lite=300, pro=skip).
- `clampPolicyForTier`: lite downgrades/disables every write+auto action and
  leaves read/summarize/draft; pro is identity; (free is unreachable but asserted
  to clamp to nothing-executes for safety).
- proactive selector: non-pro excluded, pro included, missing-row treated as free.

**Jest (client):**
- ChatScreen: a `429 chat_quota` response → input disabled + paywall banner shown
  + `presentPaywallIfNeeded` called; clears after `resets_at`.
- Settings: free/lite tapping a Pro agent control calls the paywall, does not flip
  the toggle; pro flips normally.

## Key file references (for the plan)

- Chat cap: `supabase/migrations/2026*_chat_quota.sql` (new),
  `supabase/functions/chat-run/index.ts` (~L99–122),
  `supabase/functions/_shared/entitlement-read.ts` (reuse),
  shared limits constant (new, importable by client + server),
  `src/lib/hooks.ts` `useChat` (~L5240–5340 round-0 handling),
  `src/screens/ChatScreen.tsx` (input ~L725, dock ~L415–471).
- Agent: `supabase/functions/agent-tick/index.ts` (per-user loop ~L49),
  `_shared/agent/build-deps.ts` `selectEligibleUserIds` (~L454),
  `_shared/agent/types.ts` `DEFAULT_POLICY`/`ACTION_DEFAULT_MODE` (~L77/L108),
  policy-resolution site for the clamp.
- Proactive: `agent-commitments/index.ts`, `agent-reflect/index.ts`,
  `agent-memory-followups/index.ts` + shared `selectAgentEnabledUsers`.
- Client tier: `src/lib/hooks.ts` `useEntitlement()` (~L214), `src/lib/paywall.ts`.

## Deploy order

Per project convention ([[project_client_server_pr_split]]): server first
(migration + edge fn redeploys: chat-run, agent-tick, agent-commitments,
agent-reflect, agent-memory-followups), then client OTA from main.
Adding agent tool gating touches policy — re-verify the four-wiring-spots
regression ([[project_scheduling_renewals_build]]) even though we are clamping,
not adding.
