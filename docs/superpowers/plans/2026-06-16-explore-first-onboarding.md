# Explore-First Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let new downloads land directly in the real (empty) app logged-out, then trigger the onboarding wizard on sign-in, with the paywall as the closing step.

**Architecture:** Client-only change in `App.tsx` plus two new components and one pure helper. The first-launch device-gate that auto-opens the wizard is replaced by a post-auth trigger. A persistent login CTA bar and an `AuthSheet` overlay (Animated.View, not a native Modal) are added. The paywall fires at the existing onboarding terminal points.

**Tech Stack:** React Native + Expo, TypeScript, jest-expo + @testing-library/react-native, RevenueCat (`presentPaywallIfNeeded`), Supabase auth (`useAuth`).

---

## File structure

- **Create** `src/lib/onboarding-trigger.ts` — pure decision helper for whether the wizard opens after sign-in. Unit-tested.
- **Create** `src/lib/__tests__/onboarding-trigger.test.ts` — tests for the helper.
- **Create** `src/components/LoginCtaBar.tsx` — persistent logged-out CTA bar.
- **Create** `src/components/__tests__/LoginCtaBar.test.tsx` — render/press test.
- **Create** `src/screens/AuthSheet.tsx` — sign-in overlay (Apple/Google/Microsoft).
- **Create** `src/screens/__tests__/AuthSheet.test.tsx` — render/press test.
- **Modify** `App.tsx` — add `authSheetOpen` state, render the two new components, replace the device-gate effect with a post-auth trigger effect, add `requireAuth`, wire the paywall at onboarding end, drop the v2-intro "no user → close" branch.

**Note on testing scope:** `App.tsx` is a 957-line integration component with no existing unit test, consistent with the codebase (logic lives in `src/lib/*` with tests there). Pure logic (Task 1) and the new leaf components (Tasks 2–3) are TDD'd. The `App.tsx` wiring tasks (4–7) are verified by typecheck + manual simulator QA (Task 8), matching how the rest of `App.tsx` is maintained.

---

### Task 1: `decideOnboardingTrigger` pure helper

Encapsulates the "should the wizard open right after sign-in?" rule so it is unit-testable away from `App.tsx`. Mirrors the port-forward logic already in the device-gate effect (App.tsx 243–271).

**Files:**
- Create: `src/lib/onboarding-trigger.ts`
- Test: `src/lib/__tests__/onboarding-trigger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/onboarding-trigger.test.ts
import { decideOnboardingTrigger } from '../onboarding-trigger';

describe('decideOnboardingTrigger', () => {
  const base = { isDemo: false, deviceShowPending: true, uidShowPending: true };

  it('opens the wizard for a brand-new signed-in user', () => {
    expect(decideOnboardingTrigger(base)).toBe('open');
  });

  it('skips for a demo user', () => {
    expect(decideOnboardingTrigger({ ...base, isDemo: true })).toBe('skip');
  });

  it('skips (and ports the device flag) when the uid already saw onboarding', () => {
    expect(decideOnboardingTrigger({ ...base, uidShowPending: false })).toBe('mark-device-shown');
  });

  it('skips when the device flag is already marked', () => {
    expect(decideOnboardingTrigger({ ...base, deviceShowPending: false })).toBe('skip');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/lib/__tests__/onboarding-trigger.test.ts`
Expected: FAIL — "Cannot find module '../onboarding-trigger'".

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/onboarding-trigger.ts

export interface OnboardingTriggerInput {
  /** true when the signed-in user is the demo account. */
  isDemo: boolean;
  /** result of shouldShowV2OnboardingDevice() — device flag not yet set. */
  deviceShowPending: boolean;
  /** result of shouldShowV2Onboarding(uid) — per-uid flag not yet set. */
  uidShowPending: boolean;
}

export type OnboardingTriggerDecision = 'open' | 'skip' | 'mark-device-shown';

/**
 * Decides what to do with the onboarding wizard right after an auth
 * transition. 'open' shows the wizard; 'mark-device-shown' is the
 * port-forward case (returning user who saw onboarding under the old
 * per-uid system) — caller marks the device flag and does NOT open;
 * 'skip' does nothing.
 */
export function decideOnboardingTrigger(
  input: OnboardingTriggerInput,
): OnboardingTriggerDecision {
  if (input.isDemo) return 'skip';
  if (!input.deviceShowPending) return 'skip';
  if (!input.uidShowPending) return 'mark-device-shown';
  return 'open';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/lib/__tests__/onboarding-trigger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/onboarding-trigger.ts src/lib/__tests__/onboarding-trigger.test.ts
git commit -m "feat(client): add post-auth onboarding-trigger decision helper

- pure rule for when the wizard opens after sign-in
- covers demo bypass and the returning-user port-forward case"
```

---

### Task 2: `LoginCtaBar` component

Persistent CTA shown only while logged out, pinned above the tab chrome.

**Files:**
- Create: `src/components/LoginCtaBar.tsx`
- Test: `src/components/__tests__/LoginCtaBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/__tests__/LoginCtaBar.test.tsx
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { LoginCtaBar } from '../LoginCtaBar';

describe('LoginCtaBar', () => {
  it('renders the Danish CTA label', () => {
    const { getByText } = render(<LoginCtaBar onPress={() => {}} />);
    expect(getByText('Log ind for at komme i gang')).toBeTruthy();
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByText } = render(<LoginCtaBar onPress={onPress} />);
    fireEvent.press(getByText('Log ind for at komme i gang'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/components/__tests__/LoginCtaBar.test.tsx`
Expected: FAIL — "Cannot find module '../LoginCtaBar'".

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/LoginCtaBar.tsx
import React from 'react';
import { Pressable, Text, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  onPress: () => void;
}

/**
 * Persistent logged-out call-to-action. Rendered by App.tsx only while
 * `loggedOut`, sitting just above the tab chrome. Tapping opens the AuthSheet.
 */
export function LoginCtaBar({ onPress }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingBottom: insets.bottom + 12 }]} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Text style={styles.label}>Log ind for at komme i gang</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    alignItems: 'stretch',
  },
  button: {
    backgroundColor: '#1C1C1A',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  pressed: { opacity: 0.85 },
  label: { color: '#FBFBFA', fontSize: 16, fontWeight: '600' },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/components/__tests__/LoginCtaBar.test.tsx`
Expected: PASS (2 tests).

If `react-native-safe-area-context` is not auto-mocked by jest-expo, add this stub at the top of the test file (above the import):

```tsx
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
```

- [ ] **Step 5: Commit**

```bash
git add src/components/LoginCtaBar.tsx src/components/__tests__/LoginCtaBar.test.tsx
git commit -m "feat(client): add persistent logged-out login CTA bar"
```

---

### Task 3: `AuthSheet` sign-in overlay

The sign-in surface offering Apple/Google/Microsoft. iCloud is intentionally absent (it is a mail connection requiring an existing account, handled later in the onboarding connect step).

**Files:**
- Create: `src/screens/AuthSheet.tsx`
- Test: `src/screens/__tests__/AuthSheet.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/screens/__tests__/AuthSheet.test.tsx
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

const signInWithGoogle = jest.fn().mockResolvedValue({ error: null });
const signInWithMicrosoft = jest.fn().mockResolvedValue({ error: null });
const signInWithApple = jest.fn().mockResolvedValue({ error: null });

jest.mock('../../lib/auth', () => ({
  useAuth: () => ({
    signInWithGoogle,
    signInWithMicrosoft,
    signInWithApple,
    appleAvailable: true,
  }),
}));

import { AuthSheet } from '../AuthSheet';

describe('AuthSheet', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the three account providers', () => {
    const { getByText } = render(<AuthSheet onClose={() => {}} />);
    expect(getByText('Fortsæt med Apple')).toBeTruthy();
    expect(getByText('Fortsæt med Google')).toBeTruthy();
    expect(getByText('Fortsæt med Microsoft')).toBeTruthy();
  });

  it('does NOT render an iCloud sign-in button', () => {
    const { queryByText } = render(<AuthSheet onClose={() => {}} />);
    expect(queryByText('Fortsæt med iCloud')).toBeNull();
  });

  it('calls signInWithGoogle when the Google button is tapped', () => {
    const { getByText } = render(<AuthSheet onClose={() => {}} />);
    fireEvent.press(getByText('Fortsæt med Google'));
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/screens/__tests__/AuthSheet.test.tsx`
Expected: FAIL — "Cannot find module '../AuthSheet'".

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/screens/AuthSheet.tsx
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';

interface Props {
  /** Called after a successful sign-in or when the user dismisses the sheet. */
  onClose: () => void;
}

type ProviderId = 'apple' | 'google' | 'microsoft';

/**
 * Logged-out sign-in surface. Rendered by App.tsx as an Animated.View overlay
 * (NOT a native Modal — see the iOS modal-stacking lesson). Offers the three
 * real account providers; iCloud mail is connected later, inside onboarding.
 */
export function AuthSheet({ onClose }: Props) {
  const { signInWithApple, signInWithGoogle, signInWithMicrosoft, appleAvailable } = useAuth();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<ProviderId | null>(null);

  const run = async (id: ProviderId, fn: () => Promise<unknown>) => {
    if (busy) return;
    try {
      setBusy(id);
      await fn();
      onClose();
    } catch (err) {
      if (__DEV__) console.warn('[auth-sheet] sign-in failed:', err);
    } finally {
      setBusy(null);
    }
  };

  const providers: Array<{ id: ProviderId; label: string; onPress: () => void; show: boolean }> = [
    { id: 'apple', label: 'Fortsæt med Apple', show: appleAvailable, onPress: () => run('apple', signInWithApple) },
    { id: 'google', label: 'Fortsæt med Google', show: true, onPress: () => run('google', signInWithGoogle) },
    { id: 'microsoft', label: 'Fortsæt med Microsoft', show: true, onPress: () => run('microsoft', signInWithMicrosoft) },
  ];

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.dismiss}>
        <Text style={styles.dismissLabel}>Luk</Text>
      </Pressable>
      <Text style={styles.title}>Log ind på Zolva</Text>
      <Text style={styles.subtitle}>Vælg hvordan du vil komme i gang.</Text>
      <View style={styles.buttons}>
        {providers.filter((p) => p.show).map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            onPress={p.onPress}
            disabled={busy !== null}
            style={({ pressed }) => [styles.provider, pressed && styles.pressed]}
          >
            {busy === p.id ? <ActivityIndicator color="#1C1C1A" /> : <Text style={styles.providerLabel}>{p.label}</Text>}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FBFBFA', paddingHorizontal: 24 },
  dismiss: { alignSelf: 'flex-end', padding: 8 },
  dismissLabel: { fontSize: 16, color: '#6B6B66' },
  title: { fontSize: 28, fontWeight: '700', color: '#1C1C1A', marginTop: 16 },
  subtitle: { fontSize: 16, color: '#6B6B66', marginTop: 8, marginBottom: 32 },
  buttons: { gap: 12 },
  provider: {
    borderWidth: 1,
    borderColor: '#1C1C1A',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  pressed: { opacity: 0.7 },
  providerLabel: { fontSize: 16, fontWeight: '600', color: '#1C1C1A' },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/screens/__tests__/AuthSheet.test.tsx`
Expected: PASS (3 tests). If `react-native-safe-area-context` is not auto-mocked, add the same stub shown in Task 2 Step 4.

- [ ] **Step 5: Commit**

```bash
git add src/screens/AuthSheet.tsx src/screens/__tests__/AuthSheet.test.tsx
git commit -m "feat(client): add AuthSheet sign-in overlay (Apple/Google/Microsoft)"
```

---

### Task 4: Wire AuthSheet + LoginCtaBar into App.tsx

Add the overlay state, render both components, and gate the chrome correctly. No new auto-open behaviour yet — that is Task 5.

**Files:**
- Modify: `App.tsx`

- [ ] **Step 1: Add the imports**

Near the other screen imports (App.tsx ~78–82) add:

```tsx
import { AuthSheet } from './src/screens/AuthSheet';
import { LoginCtaBar } from './src/components/LoginCtaBar';
import { decideOnboardingTrigger } from './src/lib/onboarding-trigger';
```

- [ ] **Step 2: Add overlay state**

After the `adminConsentOpen` state (App.tsx ~196) add:

```tsx
  const [authSheetOpen, setAuthSheetOpen] = useState(false);
```

- [ ] **Step 3: Add an open helper near the other open* helpers (after `openAdminConsent`, ~598)**

```tsx
  const openAuthSheet = () => {
    Haptics.selectionAsync();
    setAuthSheetOpen(true);
  };
  const closeAuthSheet = () => setAuthSheetOpen(false);
```

- [ ] **Step 4: Render the AuthSheet overlay**

Add it alongside the other mutually-exclusive overlays, immediately AFTER the `adminConsentOpen` block (App.tsx ~814, before the onboarding block):

```tsx
        {authSheetOpen && !chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && !icloudSetupOpen && !adminConsentOpen && !onboardingOpen && (
          <Animated.View
            key="auth-sheet"
            style={StyleSheet.absoluteFill}
            entering={SlideInDown.duration(320)}
            exiting={SlideOutDown.duration(260)}
          >
            <AuthSheet onClose={closeAuthSheet} />
          </Animated.View>
        )}
```

- [ ] **Step 5: Gate the chrome on the auth sheet and render the CTA bar**

Update the chrome guard (App.tsx ~926) to also hide while the auth sheet is open, and render `LoginCtaBar` when logged out. Replace the chrome block with:

```tsx
      {!chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && !icloudSetupOpen && !adminConsentOpen && !onboardingOpen && !authSheetOpen && (
        <View
          style={styles.chrome}
          pointerEvents="box-none"
          onLayout={(e) => setChromeHeight(e.nativeEvent.layout.height)}
        >
          <PhoneChrome
            active={tab}
            onChange={switchTab}
            onAskZolva={openChat}
            darkBg={chromeOverDark}
            badges={{ today: pendingProposalCount }}
          />
        </View>
      )}
      {loggedOut && !chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && !icloudSetupOpen && !adminConsentOpen && !onboardingOpen && !authSheetOpen && (
        <LoginCtaBar onPress={openAuthSheet} />
      )}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors. (Pre-existing: `hooks.ts ~5327` TS2322 and the two NotificationsScreen errors per project notes — those are unrelated and allowed.)

- [ ] **Step 7: Commit**

```bash
git add App.tsx
git commit -m "feat(client): render AuthSheet overlay and logged-out login CTA bar"
```

---

### Task 5: Replace first-launch auto-open with a post-auth trigger

Stop opening the wizard on cold launch; open it on the sign-in transition instead, using `decideOnboardingTrigger`. Also drop the now-dead "no user → close" branch in v2-intro `onComplete`.

**Files:**
- Modify: `App.tsx`

- [ ] **Step 1: Replace the device-gate effect (App.tsx ~243–271)**

Replace the entire `useEffect` block described in the comment "Open V2 onboarding for first-time launches" with:

```tsx
  // Open the V2 onboarding wizard on the sign-in transition (NOT on cold
  // launch). Logged-out cold launches land in the empty app behind the
  // login CTA; the wizard only appears once the user authenticates. Reuses
  // the existing device + per-uid gates via decideOnboardingTrigger.
  useEffect(() => {
    if (authInitializing) return;
    if (onboardingOpen) return;
    const uid = user?.id;
    if (!uid) return;
    let cancelled = false;
    void (async () => {
      const [deviceShowPending, uidShowPending] = await Promise.all([
        shouldShowV2OnboardingDevice(),
        shouldShowV2Onboarding(uid),
      ]);
      if (cancelled) return;
      const decision = decideOnboardingTrigger({
        isDemo: isDemoUser(user),
        deviceShowPending,
        uidShowPending,
      });
      if (decision === 'mark-device-shown') {
        await markV2OnboardingShownDevice();
        return;
      }
      if (decision !== 'open') return;
      setOnboardingStage('v2-intro');
      setOnboardingOpen(true);
    })();
    return () => { cancelled = true; };
  }, [user?.id, user, authInitializing, onboardingOpen]);
```

- [ ] **Step 2: Simplify the v2-intro `onComplete` branch (App.tsx ~856–860)**

Because sign-in now always precedes the wizard, `user?.id` is set during the flow. Replace the trailing branch:

```tsx
                  if (user?.id) {
                    setOnboardingStage('intro');
                  } else {
                    setOnboardingOpen(false);
                  }
```

with:

```tsx
                  // Auth precedes the wizard now, so user.id is always set
                  // here — advance straight into the backfill chain.
                  setOnboardingStage('intro');
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors.

- [ ] **Step 4: Run the helper tests (still green)**

Run: `npx jest src/lib/__tests__/onboarding-trigger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add App.tsx
git commit -m "feat(client): trigger onboarding on sign-in instead of cold launch

- logged-out cold launches now land in the empty app behind the login CTA
- wizard opens on the auth transition via decideOnboardingTrigger
- drop the dead no-user branch in the v2-intro completion handler"
```

---

### Task 6: Gate auth-requiring taps to the AuthSheet

While logged out, the central "Ask Zolva" chat button (and any account-required action surfaced through App.tsx) routes to the sign-in sheet instead of opening an unauthenticated chat.

**Files:**
- Modify: `App.tsx`

- [ ] **Step 1: Add a `requireAuth` wrapper near the open helpers (after `openAuthSheet`, Task 4 Step 3)**

```tsx
  // Logged-out taps that need an account open the sign-in sheet instead of
  // running the action. Demo users count as authed and pass through.
  const requireAuth = (action: () => void) => {
    if (loggedOut) {
      openAuthSheet();
      return;
    }
    action();
  };
```

- [ ] **Step 2: Route the chat entry point through `requireAuth`**

The chrome passes `onAskZolva={openChat}` (App.tsx ~935). Change it to:

```tsx
            onAskZolva={() => requireAuth(openChat)}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors.

- [ ] **Step 4: Commit**

```bash
git add App.tsx
git commit -m "feat(client): route logged-out Ask Zolva taps to the sign-in sheet"
```

---

### Task 7: Present the paywall at the end of onboarding

After the onboarding chain finishes for a new user, present the RevenueCat paywall. `presentPaywallIfNeeded('pro')` is a no-op for users who are already entitled.

**Files:**
- Modify: `App.tsx`

- [ ] **Step 1: Add the import (near the other lib imports)**

```tsx
import { presentPaywallIfNeeded } from './src/lib/paywall';
```

- [ ] **Step 2: Add a shared onboarding-finish helper near the open helpers**

```tsx
  // Closes the onboarding chain and presents the conversion paywall. The
  // paywall is a no-op if the user is already entitled, so returning users
  // re-running the chain won't be nagged.
  const finishOnboarding = (uid: string) => {
    void markOnboardingBackfillShown(uid);
    setOnboardingOpen(false);
    setOnboardingForceRerun(false);
    setOnboardingFailedJobs([]);
    void presentPaywallIfNeeded('pro');
  };
```

- [ ] **Step 3: Call it from the fact-review `onDone` (App.tsx ~900–906)**

Replace the `OnboardingFactReviewScreen` `onDone` body:

```tsx
                onDone={() => {
                  const uid = user.id;
                  void markOnboardingBackfillShown(uid);
                  setOnboardingOpen(false);
                  setOnboardingForceRerun(false);
                  setOnboardingFailedJobs([]);
                }}
```

with:

```tsx
                onDone={() => finishOnboarding(user.id)}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no NEW errors.

- [ ] **Step 5: Commit**

```bash
git add App.tsx
git commit -m "feat(client): present the paywall at the end of onboarding"
```

---

### Task 8: Full verification + manual QA

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS; the 3 new test files (onboarding-trigger, LoginCtaBar, AuthSheet) included and green.

- [ ] **Step 2: Typecheck (whole project)**

Run: `npm run typecheck`
Expected: only the documented pre-existing errors (`hooks.ts ~5327`, NotificationsScreen ×2). No new errors.

- [ ] **Step 3: Manual QA on the iOS simulator**

Run the app (`npx expo start` / existing run skill) and confirm:
- Fresh launch (logged out, after clearing the device onboarding flag or fresh install) lands in the real app with empty states — **no wizard auto-opens** — and the "Log ind for at komme i gang" bar is visible above the tabs.
- Tapping the CTA bar opens the AuthSheet; tabs/chrome hide while it is open; "Luk" dismisses back to the empty app.
- Tapping "Ask Zolva" while logged out opens the AuthSheet (not chat).
- Signing in as a brand-new user opens the onboarding wizard; completing it (through fact review) presents the paywall, then lands in the populated app.
- Signing in as a returning user (gates already marked) goes straight to the app with no wizard; paywall skipped if already subscribed.
- Demo login (`demo@zolva.dk` / `demo`) bypasses the CTA/wizard entirely.

- [ ] **Step 4: Final review commit (if QA required tweaks)**

Commit any fixes found during QA with a `fix(client):` message. If none, no commit needed.

---

## Self-review notes

- **Spec coverage:** flow steps 1–6 → Tasks 4 (empty shell + CTA), 3 (sign-in sheet), 5 (post-auth trigger), 7 (paywall). Components 1–7 → Tasks 2, 3, 6, 5, 5, 7. Edge cases → Task 1 (demo/returning) + Task 8 QA. iCloud nuance → Task 3 (no iCloud button) + unchanged onboarding connect step.
- **Placeholder scan:** none — every code step has full content.
- **Type consistency:** `decideOnboardingTrigger` input keys (`isDemo`, `deviceShowPending`, `uidShowPending`) match between Task 1 and Task 5; `openAuthSheet`/`closeAuthSheet`/`requireAuth`/`finishOnboarding` defined once and referenced consistently; gate function names (`shouldShowV2OnboardingDevice`, `shouldShowV2Onboarding`, `markV2OnboardingShownDevice`, `markOnboardingBackfillShown`) match the existing App.tsx imports.
