# Billing Foundation — Design

**Date:** 2026-06-07
**Status:** Approved (design), pending implementation plan
**Sub-project:** #1 of a 4-part "real billing" effort (see Decomposition)

## Context & motivation

Zolva is currently fully unmetered: `useSubscription()` is a stub that returns
`null`, there is no billing library, no entitlements, no paywall. The only
"trial" reference in the codebase is cosmetic text in Settings.

We want a two-tier paid subscription model (Lite + Pro) on top of an
Apple-required free baseline, with a 7-day Pro trial. Cost analysis of live
usage (12 users over ~12 days) showed the real marginal cost per active user is
small — the agent runs on **Haiku 4.5**, chat on **Sonnet 4.6**, and Opus is
effectively unused (one call in the whole dataset). A typical active user costs
~$1–5/mo all-in; the heaviest real user ~$4/mo. This makes the pricing below
comfortably profitable and a 7-day Pro trial trivially cheap (~$0.45–0.90 per
trialist).

This sub-project builds the **foundation only**: a source of truth for "what
tier is this user," readable both client-side (UI) and server-side (the
autonomous agent, which runs with no client present), plus enough purchase
plumbing to test the loop end-to-end. Feature gating, the polished paywall, and
the original onboarding/nudge asks are later sub-projects.

## Decomposition of the larger "real billing" effort

1. **Billing foundation** *(this spec)* — provider integration, products, the
   trial mechanism, and the entitlement source of truth.
2. **Feature gating / enforcement** — enforce Free/Lite/Pro across the app +
   agent + chat: agent-tick eligibility by tier, free-tier message caps, gating
   Pro-only proactive behaviors.
3. **Paywall + trial UX** — paywall screen, trial-start flow, upsell prompts,
   where the paywall is presented.
4. **Original asks** — forced-win onboarding (agent drafts a real reply the
   moment onboarding finishes), trial urgency nudge, manual proactive triggers.

Each sub-project gets its own spec → plan → implementation cycle.

## Decisions locked in

- **Provider:** RevenueCat via `react-native-purchases`. Works with the
  project's dev builds (not Expo Go, which the project avoids anyway). It
  abstracts StoreKit + Google Play Billing into a single entitlements model,
  handles trials/intro offers, and provides webhooks to sync into Supabase.
  Free under ~$2.5k/mo tracked revenue.
- **Products (3 SKUs):**
  - Lite — 49 DKK / month
  - Pro — 99 DKK / month (7-day trial)
  - Pro — ~990 DKK / year (7-day trial)
- **Trial:** store-managed intro offer, **card up front**, **Pro-only**, 7 days,
  auto-converts to paid. The store handles conversion and post-trial billing, so
  there is **no app-side post-trial enforcement gate** to build.
- **Entitlement model:** RevenueCat entitlements `pro` and `lite`. Tier
  resolution: `pro` active → **pro**; else `lite` active → **lite**; else
  **free**. Absence of any entitlement = **free baseline** (not locked).
- **Free tier (Apple-required):** modelled on ChatGPT/Claude free — a capped
  message allotment plus zero-marginal-cost features (reminders, local features).
  **Nothing that costs real money** lives in free: no agent runs (even Haiku
  costs), no proactive behaviors. Exact caps are defined in sub-project #2; for
  the foundation, "free" is simply the default state (no entitlement row).
- **No migration:** existing ~12 users get no special-casing. They drop to free
  and flow through the normal funnel like any new user. No backfill logic.

## Architecture & data flow

```
App (after Supabase auth)
  └─ Purchases.logIn(supabase user.id)   ← ties purchases to the account
  └─ reads customerInfo.entitlements      ← client-side tier (instant, cached)

Purchase (sandbox/prod)
  └─ Apple/Google → RevenueCat
        └─ webhook ──► revenuecat-webhook edge fn
                          └─ upsert user_entitlements row   ← server-side tier
                                  └─ agent-tick / chat read this (in #2)
```

Two readers, one truth. The **client** reads RevenueCat's `customerInfo`
directly (fast, offline-tolerant) for UI. The **server** reads a mirrored
Supabase table, because `agent-tick` runs on a cron with no client present. The
webhook keeps them in sync. RevenueCat's `appUserID` is set to the Supabase auth
`user.id` via `Purchases.logIn(user.id)`, so purchases are tied to the account
and survive reinstalls / work cross-device.

## Data model — `user_entitlements`

| column | type | notes |
|---|---|---|
| `user_id` | uuid PK | FK `auth.users(id)` on delete cascade |
| `tier` | text | `free` \| `lite` \| `pro` (CHECK constraint) |
| `is_trial` | boolean | true during the 7-day Pro trial |
| `current_period_end` | timestamptz | renewal/expiry; powers trial-end logic later |
| `store` | text | `app_store` \| `play_store` \| `promotional` |
| `product_id` | text | which SKU is active |
| `rc_app_user_id` | text | RevenueCat id (= supabase `user.id`) |
| `updated_at` | timestamptz | set on every upsert |
| `raw_event` | jsonb | last webhook payload, for debugging |

- **RLS:** a user may `SELECT` their own row; only the service role (the webhook
  function) may write. No client writes.
- **Absence of a row = `free`.** This is why "no migration" works cleanly —
  there is nothing to backfill; every user is free until a webhook says
  otherwise.
- Upsert is **idempotent on `user_id`** (one row per user, last event wins).

## Components

1. **Client SDK init** — initialize RevenueCat on app start; call
   `Purchases.logIn(user.id)` after Supabase auth and `Purchases.logOut()` on
   sign-out. (~1 new lib file + a hook into `App.tsx`.)
2. **`useEntitlement()` hook** — replaces the `useSubscription()` stub. Reads
   `customerInfo` and returns `{ tier, isTrial, trialEndsAt, periodEnd }`. The
   existing `useSubscription` either delegates to this or is removed; the
   `Subscription` stub type in `src/lib/types.ts` is updated/replaced.
3. **`revenuecat-webhook` edge function** — validates RevenueCat's
   `Authorization` header secret, parses the event, and upserts
   `user_entitlements`. Deployed `--no-verify-jwt` (it is not a user-auth call;
   it authenticates via the shared RevenueCat secret). Idempotent on `user_id`.
   Handles: initial purchase, renewal, trial start, expiration/cancellation,
   refund, product change (Lite↔Pro), billing issue.
4. **Server `getEntitlement(userId)` helper** — a shared reader (in
   `supabase/functions/_shared/`) that the agent and chat will gate on in
   sub-project #2. Returns `free` when no row exists.
5. **Minimal dev purchase trigger** — a temporary button calling
   `purchasePackage()` so the full sandbox → webhook → table loop is testable in
   #1. The real paywall is sub-project #3. (Confirmed in scope.)

## Testing

- **Webhook handler (unit):** event → upsert for each event type — initial
  purchase, renewal, trial start, expiration, refund, product change — plus the
  tier-resolution logic (`pro` > `lite` > `free`).
- **End-to-end (sandbox):** StoreKit configuration file / sandbox tester →
  purchase → assert: `customerInfo` shows the entitlement, the webhook fires, the
  `user_entitlements` row is correct, and `getEntitlement()` returns the right
  tier.
- **Free default:** a user with no row resolves to `free` everywhere (client hook
  and server helper).

## Explicitly out of scope (later sub-projects)

- Feature gating, free-tier message caps, agent eligibility by tier → **#2**
- Polished paywall UI, trial-start UX, upsell prompts → **#3**
- Forced-win onboarding, trial urgency nudge, manual proactive triggers → **#4**

## Open prerequisites (ops, not code)

- Create the RevenueCat project and link App Store Connect + Google Play Console.
- Configure the 3 subscription products and the 7-day intro offer in App Store
  Connect / Play Console, and map them to the `pro` / `lite` entitlements in
  RevenueCat.
- Obtain the RevenueCat SDK API keys (iOS/Android) and the webhook auth secret;
  store them as app config / Supabase function secrets.
