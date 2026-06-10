# Forced-win onboarding + trial nudges — Design

**Date:** 2026-06-10
**Status:** Approved
**Sub-project:** Billing #4 (after #1 foundation, #2 feature gating; before #3 paywall gates)

## Goal

A brand-new user should experience real, personal value (the "forced win") during
onboarding — *before* we pitch the Pro trial — and users who skip the pitch or are
mid-trial should get well-timed, low-friction nudges. Conversion path: real first
brief → soft trial pitch → skipper nudge → trial-ending reminder. Feature gates
(#3) remain the durable backstop and are out of scope here.

## Current state (verified 2026-06-10)

- Onboarding V2 (`src/screens/OnboardingFlowScreen.tsx`) is a 7-step flow; step 6
  connects mail/calendar/drive, step 7 shows a **sample** brief preview.
  Connecting providers in step 6 is the expected path for essentially all users
  (they can disconnect later), so the win path is the mainline, not an edge case.
- Paywall surfaces are reactive only: chat-cap banner (`ChatScreen.tsx` ~444) and
  Settings upgrade button (`SettingsScreen.tsx` ~2052). Nothing in onboarding.
- `src/lib/entitlement.ts` already resolves `periodType: 'TRIAL'` and
  `trialEndsAt`, but no trial-start or trial-end nudge exists anywhere.
- `supabase/functions/daily-brief/index.ts` already supports per-user invocation:
  a Bearer-authed call scopes to `scopedUserId` (line ~99–114). However
  `windowMatches` (line ~143) refuses generation outside the user's configured
  brief window, so an on-demand call during onboarding currently does nothing.

## Design

### 1. Server — on-demand forced brief

Add a `force: true` flag to the `daily-brief` request body:

- Honored **only** on the user-authed (Bearer) path. The cron path
  (`x-cron-secret`) ignores it — forced generation is always single-user.
- When forced: skip `windowMatches`, derive `kind` from the user's local hour
  (morning < 12:00, midday < 17:00, else evening) using the existing
  `localHourMinute` helper, then call `generateOneBrief` unchanged.
- Existing dedupe inside `generateOneBrief` stays as-is.
- Deployed with `--no-verify-jwt` (project standard for user-auth functions).

### 2. Client — step 7 becomes the real win

- After step 6 completes with ≥1 mail provider connected, fire the forced
  `daily-brief` call in the background while the user transitions to step 7.
- Step 7 shows Stone in `thinking` mood with loading copy
  ("Zolva læser din indbakke…") until the real brief lands, then renders it
  using the existing structured-sections brief layout.
- Fail-safe (rare in practice since provider connect is the universal path, but
  the win must never block onboarding): no mail connected, generation error, or
  >20s timeout → fall back to the current sample preview. Onboarding always
  completes.

### 3. Trial pitch — soft, skippable

- When the user dismisses the real brief (or its fallback) in step 7, present
  the existing RevenueCat paywall (`presentPaywall()` from `src/lib/paywall.ts`)
  with the Pro trial offer front and center.
- Fully skippable — closing it continues to the app on the free tier. No hard
  gate, no forced choice.
- Record `pitchedAt` timestamp + outcome (`started` | `skipped`) in
  AsyncStorage for nudge eligibility.

### 4. Skipper nudge — one-time Today card

- Eligibility: tier is still `free` AND pitch outcome was `skipped` AND
  `pitchedAt` ≥ 3 days ago AND not previously dismissed.
- Surface: a one-time card on the Today feed — "Du har fået X briefs fra Zolva.
  Prøv Pro gratis" — tap opens the paywall; dismiss is permanent
  (AsyncStorage flag).
- No push, no server state. Reinstall resets the flag; acceptable for a nudge.

### 5. Trial-ending nudge

- When entitlement resolves to `periodType: 'TRIAL'` with a `trialEndsAt`:
  - Schedule an idempotent **local notification** at `trialEndsAt − 2 days`
    ("Din Pro-prøveperiode slutter om 2 dage"), keyed by a stable notification
    id so re-scheduling on every app launch is a no-op.
  - Show a Today-feed banner during the final 48 h of the trial.
- Cancel both when the entitlement leaves TRIAL (converted, cancelled, expired).
- Pure client — no new tables, no cron.

## Error handling

- Forced-brief call failures are swallowed into the step-7 fallback; never
  surfaced as a blocking error during onboarding.
- Paywall presentation failures (RevenueCat offline etc.) fail silent and the
  user proceeds; nudges catch them later.
- Notification permission denied → trial-ending nudge degrades to the Today
  banner only.

## Testing (TDD per slice)

- **Server:** `force` bypasses `windowMatches`; cron path rejects/ignores
  `force`; kind selection by local hour boundaries (11:59/12:00, 16:59/17:00);
  unauthorized forced calls still 401.
- **Client:** nudge eligibility logic (skipper: tier/outcome/age/dismissed
  combinations; trial-ending: scheduling idempotency, cancellation on tier
  change); step-7 race (brief arrives before/after user reaches step 7) and
  fallback on timeout/error.

## Out of scope

- Hard paywall gates (#3 — next sub-project).
- Server-side nudge state or push via the agent's `nudge.push` tool.
- Android-specific paywall work beyond what RevenueCat already handles.
- RevenueCat production-store swap (final step before TestFlight).
