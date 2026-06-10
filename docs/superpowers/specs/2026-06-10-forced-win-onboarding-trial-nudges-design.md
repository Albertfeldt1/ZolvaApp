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
  `localHourMinute` helper, then call `generateOneBrief`.
- **Cold-start fallback (added after code recon):** `assembleInputs` reads
  `mail_events`, which is empty for a brand-new user (poll-mail hasn't run),
  and `generateOneBrief` skips entirely when all inputs are empty. On the
  forced path only, when `mail_events` yields nothing, fetch ~3 live inbox
  headers via the stored refresh token (`_shared/oauth.ts` +
  `_shared/backfill-providers/` gmail/graph readers — same plumbing as
  onboarding backfill). iCloud-only users are out of scope for the fallback.
- `generateOneBrief` returns `{ status, briefId }` so the response can point
  the client at the new (or already-existing) brief row.
- Existing dedupe stays: forced call on a day with an existing brief returns
  `already-briefed` plus that brief's id.
- Deployed with `--no-verify-jwt` (project standard for user-auth functions).

### 2. Client — forced brief fired from onboarding (revised after code recon)

Code recon found step 7 (`ScreenActivation`) **already renders a real live
inbox preview** — it fetches ~20 messages with the fresh OAuth token and
shows 3 actionable mails, falling back to `SAMPLE_BRIEF`. So the visual win
in step 7 already exists; what's missing is that the Today screen is empty
after onboarding until the next cron window — the broken promise.

- Step 7's existing live preview is kept untouched; no spinner, no rework.
- When the user advances past step 6 (provider connect), fire
  `requestForcedBriefOnce(uid)` in the background — a once-per-user
  (AsyncStorage-guarded) call to `daily-brief` with `force: true`.
- When the call settles, notify an in-module listener so `useTodayBrief`
  refreshes — the real persisted brief is waiting as a `BriefBanner` the
  moment the user lands on Today.
- Fail-safe: all failures are swallowed (warn-only); onboarding never blocks
  on the forced call.

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
