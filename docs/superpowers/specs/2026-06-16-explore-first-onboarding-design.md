# Explore-first onboarding — design

**Date:** 2026-06-16
**Scope:** Client-only (App.tsx + screens/components). No server/edge changes.

## Problem

On first download the app immediately opens the 7-step onboarding wizard
(`OnboardingFlowScreen`) on top of the app. OAuth sign-in is buried at step 5
(the "Trust"/connect step) and there is no paywall in the flow. New users are
forced through a wizard before they ever see the product.

We want: **download → explore the real app freely (logged out) → log in →
onboarding wizard → conversion (sign-in already done up front + paywall at the
end) → full app.**

## Target flow

1. **First launch → land in the real app, logged out.** Empty states
   everywhere. No wizard auto-opens. Tab screens already short-circuit data
   loads when `userId` is empty (verified: TodayScreen, InboxScreen,
   MemoryScreen, SettingsScreen all guard on `!userId`), so the empty shell
   renders without crashing.
2. A persistent **"Log ind / Kom i gang"** CTA bar is always visible while
   logged out, pinned just above the tab chrome.
3. **Tap CTA → sign-in sheet** offering Apple · Google · Microsoft.
4. **After successful sign-in:**
   - New user (onboarding gate still pending for uid + device) → **open the
     onboarding wizard.**
   - Returning user (gates already marked) → straight into their populated
     app, no wizard.
5. The wizard runs **fully authenticated** (welcome → diagnose → vision →
   persona → expectation → connect-sources → activation → memory
   backfill/review). The connect step's role shifts from "sign in" to "connect
   more sources."
6. **End of onboarding → paywall** via `presentPaywallIfNeeded('pro')`.
   Subscribe or dismiss; either way land in the full app.

## Current architecture (as-is)

- `App.tsx` computes `loggedOut = !authInitializing && !user` but never uses it.
- A device-gate effect (~App.tsx 243–271) calls `shouldShowV2OnboardingDevice()`
  on launch and opens the wizard regardless of auth. `v2-intro` stage does not
  require auth; later stages (`intro`/`progress`/`review`) gate on `user.id`.
- `OnboardingFlowScreen` is a 7-step flow (indices 0–6):
  `ScreenWelcome, ScreenDiagnose, ScreenVision, ScreenPersonalisation,
  ScreenExpectation, ScreenTrust (OAuth connect, index 5), ScreenActivation`.
  Its `onComplete` advances to the backfill chain if `user.id` is set, else
  closes.
- Sign-in methods live in `src/lib/auth.ts`: `signInWithApple` (iOS only),
  `signInWithGoogle`, `signInWithMicrosoft`, `signOut`. iCloud mail is set up
  via `IcloudSetupScreen` which requires an existing `userId`.
- Paywall: `src/lib/paywall.ts` — `presentPaywall()`,
  `presentPaywallIfNeeded(entitlement='pro')` (no-op if already entitled).
- Overlays in App.tsx are mutually-exclusive `Animated.View`s (chat, mail,
  notifications, sent-mails, icloud-setup, admin-consent, onboarding), NOT
  stacked native `<Modal>`s — per the iOS modal-stacking lesson.

## Components — new / changed

### 1. `LoginCtaBar` (new component)
- Pinned just above `PhoneChrome`, rendered only when `loggedOut`.
- Label: "Log ind for at komme i gang". On press → open sign-in sheet.
- Must not block content; sits in the chrome layer like the tab bar.

### 2. `AuthSheet` (new screen/overlay)
- Built as an `Animated.View` overlay, mutually exclusive with the other
  overlays (same gating pattern as `icloudSetupOpen` etc.) — **not** a native
  `<Modal>`.
- Buttons: **Apple** (iOS), **Google**, **Microsoft**. Consumes `useAuth`.
- **iCloud is intentionally NOT a top-level sign-in button**: iCloud mail is a
  connection, not an account (`IcloudSetupScreen` needs an existing `userId`).
  The iCloud-only journey is *Sign in with Apple → connect iCloud mail* inside
  the onboarding connect step / Settings.
- On successful sign-in: close the sheet; the post-auth trigger (below) decides
  whether the wizard opens.

### 3. `requireAuth(action)` helper (in App.tsx)
- If `loggedOut`, open the sign-in sheet instead of running `action`.
- Wired into `openChat` (Ask Zolva), connect-source taps, and agent actions —
  any logged-out tap that needs an account routes to the sign-in sheet.

### 4. Remove first-launch auto-open
- The device-gate effect (~App.tsx 243–271) no longer opens the wizard on cold
  launch. Onboarding is triggered by sign-in, not by launch.

### 5. Post-auth onboarding trigger (new effect)
- Fires on the `user` null→present transition: if `shouldShowV2Onboarding(uid)`
  and device-pending, set stage `v2-intro` and open the wizard.
- Reuses the existing gate functions (`shouldShowV2Onboarding`,
  `shouldShowV2OnboardingDevice`, `markV2OnboardingShown(Device)`); only the
  trigger source changes (auth transition instead of launch).

### 6. Onboarding wizard tweak (`OnboardingFlowScreen` + App.tsx)
- Because auth now precedes the wizard, `user.id` is always set during the
  flow. The `v2-intro` `onComplete` "else close (no user)" branch can be
  removed — it always advances to the backfill `intro` stage now.
- `ScreenTrust` copy shifts from "sign in" framing to "connect more sources."

### 7. Paywall at the end
- `presentPaywallIfNeeded('pro')` fires at the onboarding chain's terminal
  points for a new user — i.e. `OnboardingFactReviewScreen` `onDone` (and the
  skip paths that close the chain). No-op if already entitled.

## Edge cases

- **Returning logged-out user** → login → no wizard (uid/device gates marked),
  paywall skipped if already subscribed.
- **Explore forever, never log in** → fully usable empty shell; CTA always
  present; gated taps open the sign-in sheet.
- **Demo mode** (`demo@zolva.dk`) → unaffected; `isDemoUser` bypasses all of
  this.
- **Mid-onboarding app kill** → existing "mark shown on finish" logic
  preserved, so the 7 steps don't replay on next launch.
- **iCloud-only segment** → covered via Apple sign-in + connect iCloud mail in
  the connect step.

## Out of scope (YAGNI)

- No demo/sample data in the logged-out shell (chose "real app, empty").
- No marketing/preview carousel.
- No server, edge function, or migration changes.
