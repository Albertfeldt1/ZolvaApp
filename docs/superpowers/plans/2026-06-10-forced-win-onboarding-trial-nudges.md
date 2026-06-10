# Forced-Win Onboarding + Trial Nudges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new user gets a real persisted brief waiting on the Today screen right after onboarding, a skippable Pro-trial pitch at the end of onboarding, a one-time skipper nudge after 3 days, and a trial-ending reminder 2 days before expiry.

**Architecture:** Server: a `force: true` flag on the `daily-brief` edge function (user-auth path only) bypasses the time-window gate and falls back to live inbox headers when `mail_events` is cold. Client: a once-per-user fire-and-forget call from onboarding, a paywall pitch hooked into onboarding completion, and a pure-logic `trial-nudges` module surfaced on the Today screen + local notification.

**Tech Stack:** Supabase Edge Functions (Deno/TypeScript), React Native (Expo), RevenueCat (`react-native-purchases-ui`), expo-notifications, AsyncStorage. Tests: `deno test` (server), `npx jest` (client).

**Spec:** `docs/superpowers/specs/2026-06-10-forced-win-onboarding-trial-nudges-design.md`

**Repo conventions that bind this plan:**
- Conventional Commits, bullet bodies, no AI attribution. Do NOT push unless told.
- NEVER `git add -A` — `app.json`, `package.json`, `deno.lock`, `.gitignore`, `package-lock.json` carry pre-existing uncommitted diffs. Stage files explicitly.
- Server (`supabase/functions/**`) commits come FIRST and deploy before any client work ships.
- Deploy edge functions with `--no-verify-jwt` (Supabase project uses ES256 JWTs; gateway verification 401s otherwise). Project ref: `sjkhfkatmeqtsrysixop`.
- `npm run typecheck` has ONE pre-existing failure: TS2322 at `src/lib/hooks.ts:5037`. Ignore it; any OTHER error is yours.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `supabase/functions/daily-brief/force.ts` | Create | Pure forced-path helpers: parse `force` flag, kind-by-hour, live-unread fallback (injected deps) |
| `supabase/functions/daily-brief/force.test.ts` | Create | Deno tests for the above |
| `supabase/functions/daily-brief/index.ts` | Modify | Wire forced branch into `serve()`; `generateOneBrief` returns `{status, briefId}` |
| `src/lib/forced-brief.ts` | Create | Once-per-user forced-brief request + settled-listener |
| `src/lib/__tests__/forced-brief.test.ts` | Create | Jest tests |
| `src/lib/trial-nudges.ts` | Create | Pitch outcome storage, skipper-nudge eligibility, trial-ending banner/notification logic |
| `src/lib/__tests__/trial-nudges.test.ts` | Create | Jest tests for the pure logic |
| `src/screens/OnboardingFlowScreen.tsx` | Modify | Fire forced brief on leaving step 6 (index 5); trial pitch before `onComplete` |
| `src/components/TrialNudges.tsx` | Create | `SkipperNudgeCard` + `TrialEndingBanner` components |
| `src/screens/TodayScreen.tsx` | Modify | Render nudge surfaces; refresh brief when forced call settles |
| `src/lib/hooks.ts` | Modify | `useEntitlement` syncs the trial-ending notification |

---

### Task 1: Server — forced-path pure helpers (`force.ts`)

**Files:**
- Create: `supabase/functions/daily-brief/force.ts`
- Create: `supabase/functions/daily-brief/force.test.ts`

- [ ] **Step 1: Write the failing tests**

First check the assert import style used by the sibling test (`supabase/functions/daily-brief/compose.test.ts`) and mirror it. Assuming std assert:

```typescript
// supabase/functions/daily-brief/force.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseForceRequest, kindForHour, fetchLiveUnread, type LiveUnreadDeps } from './force.ts';

Deno.test('parseForceRequest: force=true on user path', () => {
  assertEquals(parseForceRequest({ force: true }, false), true);
});

Deno.test('parseForceRequest: cron path always ignores force', () => {
  assertEquals(parseForceRequest({ force: true }, true), false);
});

Deno.test('parseForceRequest: missing/malformed bodies are not forced', () => {
  assertEquals(parseForceRequest(null, false), false);
  assertEquals(parseForceRequest(undefined, false), false);
  assertEquals(parseForceRequest('force', false), false);
  assertEquals(parseForceRequest({ force: 'true' }, false), false);
  assertEquals(parseForceRequest({}, false), false);
});

Deno.test('kindForHour boundaries', () => {
  assertEquals(kindForHour(0), 'morning');
  assertEquals(kindForHour(11), 'morning');
  assertEquals(kindForHour(12), 'midday');
  assertEquals(kindForHour(16), 'midday');
  assertEquals(kindForHour(17), 'evening');
  assertEquals(kindForHour(23), 'evening');
});

function deps(overrides: Partial<LiveUnreadDeps> = {}): LiveUnreadDeps {
  return {
    loadRefreshToken: () => Promise.resolve('rt'),
    refreshAccessToken: () => Promise.resolve({ accessToken: 'at' }),
    fetchGmail: () => Promise.resolve([
      { from: 'Marie <marie@x.dk>', subject: 'Kontrakt' },
      { from: 'Jonas <jonas@x.dk>', subject: 'Faktura' },
    ]),
    fetchGraph: () => Promise.resolve([]),
    ...overrides,
  };
}

Deno.test('fetchLiveUnread: maps google candidates to unread shape', async () => {
  const out = await fetchLiveUnread(deps(), {} as never, 'u1', 'me@x.dk');
  assertEquals(out, [
    { from: 'Marie <marie@x.dk>', subject: 'Kontrakt' },
    { from: 'Jonas <jonas@x.dk>', subject: 'Faktura' },
  ]);
});

Deno.test('fetchLiveUnread: falls through to microsoft when google has no token', async () => {
  const out = await fetchLiveUnread(
    deps({
      loadRefreshToken: (_c, _u, p) => Promise.resolve(p === 'microsoft' ? 'rt' : null),
      fetchGraph: () => Promise.resolve([{ from: 'A', subject: 'B' }]),
    }),
    {} as never, 'u1', 'me@x.dk',
  );
  assertEquals(out, [{ from: 'A', subject: 'B' }]);
});

Deno.test('fetchLiveUnread: provider errors are swallowed, returns []', async () => {
  const out = await fetchLiveUnread(
    deps({
      refreshAccessToken: () => Promise.reject(new Error('AADSTS')),
      fetchGmail: () => Promise.reject(new Error('500')),
    }),
    {} as never, 'u1', 'me@x.dk',
  );
  assertEquals(out, []);
});

Deno.test('fetchLiveUnread: caps at 3 and fills blanks', async () => {
  const out = await fetchLiveUnread(
    deps({
      fetchGmail: () => Promise.resolve([
        { from: '', subject: '' }, { from: 'b', subject: 's2' },
        { from: 'c', subject: 's3' }, { from: 'd', subject: 's4' },
      ]),
    }),
    {} as never, 'u1', 'me@x.dk',
  );
  assertEquals(out.length, 3);
  assertEquals(out[0], { from: 'ukendt', subject: '(intet emne)' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test supabase/functions/daily-brief/force.test.ts`
Expected: FAIL — module `./force.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// supabase/functions/daily-brief/force.ts
//
// Forced ("on-demand first brief") support for the user-authed path of
// daily-brief. Pure decision helpers plus a live-inbox fallback used when a
// brand-new user has no mail_events yet (poll-mail hasn't run). Provider IO
// is injected so everything here is unit-testable.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// `force` is only honored from an authenticated user; the cron sweep must
// never generate outside each user's configured window.
export function parseForceRequest(rawBody: unknown, isCron: boolean): boolean {
  if (isCron) return false;
  if (!rawBody || typeof rawBody !== 'object') return false;
  return (rawBody as { force?: unknown }).force === true;
}

export function kindForHour(hour: number): 'morning' | 'midday' | 'evening' {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'midday';
  return 'evening';
}

type CandidateLike = { from?: string; subject?: string };

export type LiveUnreadDeps = {
  loadRefreshToken: (
    client: SupabaseClient, userId: string, provider: 'google' | 'microsoft',
  ) => Promise<string | null>;
  refreshAccessToken: (
    client: SupabaseClient, userId: string, provider: 'google' | 'microsoft', refreshToken: string,
  ) => Promise<{ accessToken: string }>;
  fetchGmail: (accessToken: string, ownEmail: string, maxFetch?: number, keep?: number) => Promise<CandidateLike[]>;
  fetchGraph: (accessToken: string, ownEmail: string) => Promise<CandidateLike[]>;
};

export type UnreadItem = { from: string; subject: string };

// Try google then microsoft; first provider that yields anything wins.
// iCloud is intentionally out of scope (needs imap-proxy round trip).
export async function fetchLiveUnread(
  deps: LiveUnreadDeps,
  client: SupabaseClient,
  userId: string,
  ownEmail: string,
): Promise<UnreadItem[]> {
  for (const provider of ['google', 'microsoft'] as const) {
    try {
      const rt = await deps.loadRefreshToken(client, userId, provider);
      if (!rt) continue;
      const { accessToken } = await deps.refreshAccessToken(client, userId, provider, rt);
      const candidates = provider === 'google'
        ? await deps.fetchGmail(accessToken, ownEmail, 25, 3)
        : await deps.fetchGraph(accessToken, ownEmail);
      const mapped = candidates.slice(0, 3).map((c) => ({
        from: c.from || 'ukendt',
        subject: c.subject || '(intet emne)',
      }));
      if (mapped.length > 0) return mapped;
    } catch (err) {
      console.warn('[daily-brief] live unread fallback failed', provider,
        err instanceof Error ? err.message : err);
    }
  }
  return [];
}
```

Note: `refreshAccessToken` in `_shared/oauth.ts` takes `(client, userId, provider, refreshToken, opts?)` and returns `RefreshResult` whose `accessToken` field this consumes — check the exact field name in `RefreshResult` (`supabase/functions/_shared/oauth.ts:31`) and adjust the deps type if it differs.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/daily-brief/force.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/daily-brief/force.ts supabase/functions/daily-brief/force.test.ts
git commit -m "feat(brief): forced-path helpers — force flag parse, kind-by-hour, live-unread fallback

- parseForceRequest honors force:true only on the user-authed path
- kindForHour: morning <12, midday <17, else evening
- fetchLiveUnread: google→microsoft live inbox headers via injected deps"
```

---

### Task 2: Server — wire forced branch into `daily-brief/index.ts`

**Files:**
- Modify: `supabase/functions/daily-brief/index.ts` (serve body ~79–153, `generateOneBrief` ~206–291)

- [ ] **Step 1: Import the helpers and capture the user email**

At the imports (after line 25):

```typescript
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import { fetchGmailCandidates } from '../_shared/backfill-providers/gmail.ts';
import { fetchGraphCandidates } from '../_shared/backfill-providers/microsoft.ts';
import { parseForceRequest, kindForHour, fetchLiveUnread, type LiveUnreadDeps } from './force.ts';
```

In the auth branch (currently sets `scopedUserId = userData.user.id;` at line 113), also capture the email:

```typescript
    scopedUserId = userData.user.id;
    scopedUserEmail = (userData.user.email ?? '').toLowerCase().trim();
```

with `let scopedUserEmail = '';` declared next to `let scopedUserId` (line 99).

- [ ] **Step 2: Parse the body once and add the forced branch**

`req.json()` throws on an empty body — guard it. Insert after the service client is created (line 118) and before the prefs query (line 122):

```typescript
  let rawBody: unknown = null;
  try {
    rawBody = await req.json();
  } catch {
    // empty or non-JSON body — normal for cron invocations
  }

  const liveDeps: LiveUnreadDeps = {
    loadRefreshToken,
    refreshAccessToken: (c, u, p, rt) => refreshAccessToken(c, u, p, rt),
    fetchGmail: fetchGmailCandidates,
    fetchGraph: fetchGraphCandidates,
  };

  // Forced on-demand brief (onboarding "first win"). Bypasses the
  // work_preferences window entirely — a brand-new user may not even have a
  // brief preference row yet.
  if (parseForceRequest(rawBody, isCron) && scopedUserId) {
    const zones = await fetchZones(client, [scopedUserId]);
    const tz = zones.get(scopedUserId) ?? 'UTC';
    const local = localHourMinute(new Date(), tz);
    const kind = kindForHour(local.hour);
    const r = await generateOneBrief(client, anthropicKey, scopedUserId, kind, tz, {
      forcedEmail: scopedUserEmail,
      liveDeps,
    });
    return json({ forced: true, kind, status: r.status, briefId: r.briefId });
  }
```

- [ ] **Step 3: Change `generateOneBrief` to return `{ status, briefId }` and add the cold-start fallback**

Signature (line 206) becomes:

```typescript
async function generateOneBrief(
  client: SupabaseClient,
  anthropicKey: string,
  userId: string,
  kind: 'morning' | 'midday' | 'evening',
  timezone: string,
  forced: { forcedEmail: string; liveDeps: LiveUnreadDeps } | null = null,
): Promise<{ status: string; briefId: string | null }> {
```

Then convert every `return '<status>'` to `return { status: '<status>', briefId: null }`, with two exceptions:

The dedupe (line 237) returns the existing id so the client can show it:

```typescript
  if (existing && existing.length > 0) {
    return { status: 'already-briefed', briefId: (existing[0] as { id: string }).id };
  }
```

After `assembleInputs` (line 239), the forced fallback runs BEFORE the `nonEmpty` check:

```typescript
  const inputs = await assembleInputs(client, userId, kind, timezone);
  // Cold start: a brand-new user has no mail_events rows yet (poll-mail
  // hasn't run). On the forced path only, pull live inbox headers so the
  // first brief isn't empty-skipped.
  if (forced && inputs.unread.length === 0) {
    inputs.unread = await fetchLiveUnread(forced.liveDeps, client, userId, forced.forcedEmail);
  }
```

And the success path (line 290) returns the inserted id:

```typescript
  return { status: 'sent', briefId: inserted.id as string };
```

- [ ] **Step 4: Update the cron-loop call site**

Line 148 becomes:

```typescript
    const r = await generateOneBrief(client, anthropicKey, pref.user_id, kind, tz);
    results.push({ userId: pref.user_id, kind, status: r.status });
```

- [ ] **Step 5: Type-check and run all daily-brief tests**

Run: `deno check supabase/functions/daily-brief/index.ts && deno test supabase/functions/daily-brief/`
Expected: check clean, all tests pass (force.test.ts + compose.test.ts).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/daily-brief/index.ts
git commit -m "feat(brief): force:true generates an on-demand brief on the user-authed path

- forced branch bypasses windowMatches; kind from user-local hour
- generateOneBrief returns {status, briefId}; already-briefed returns existing id
- cold-start: empty mail_events falls back to live inbox headers (google/microsoft)
- cron path ignores force; behavior unchanged"
```

---

### Task 3: Deploy server + smoke test — CHECKPOINT

- [ ] **Step 1: Deploy**

```bash
supabase functions deploy daily-brief --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

- [ ] **Step 2: Smoke-test the forced path**

Needs a real user JWT for `albertfeldt1@gmail.com` (the primary test account — re-resolve its user id live, it is unstable). Get a fresh access token (e.g. from a running dev client's session, or `supabase auth` tooling), then:

```bash
curl -s -X POST 'https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/daily-brief' \
  -H "Authorization: Bearer $USER_JWT" -H 'Content-Type: application/json' \
  -d '{"force": true}'
```

Expected: `{"forced":true,"kind":"<by local hour>","status":"sent","briefId":"<uuid>"}` — or `"already-briefed"` with a briefId if today's brief exists (likely for the test account; that still proves the branch + dedupe).

Also verify the cron path is untouched: invoke with the cron secret and confirm the response is the normal `{processed, results}` shape.

- [ ] **Step 3: STOP — report smoke result to the user before client work**

---

### Task 4: Client — `forced-brief.ts` (once-per-user request + settled listener)

**Files:**
- Create: `src/lib/forced-brief.ts`
- Create: `src/lib/__tests__/forced-brief.test.ts`

- [ ] **Step 1: Write the failing tests**

Mirror the mocking style of existing `src/lib/__tests__/*.test.ts` (e.g. `agent-settings.test.ts` for the supabase mock, and check how AsyncStorage is mocked — there is likely a jest setup file; follow it).

```typescript
// src/lib/__tests__/forced-brief.test.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestForcedBriefOnce, onForcedBriefSettled } from '../forced-brief';
import { supabase } from '../supabase';

jest.mock('../supabase', () => ({
  supabase: { functions: { invoke: jest.fn() } },
}));

const invoke = supabase.functions.invoke as jest.Mock;

beforeEach(async () => {
  await AsyncStorage.clear();
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { forced: true, status: 'sent', briefId: 'b1' }, error: null });
});

test('invokes daily-brief with force:true', async () => {
  await requestForcedBriefOnce('u1');
  expect(invoke).toHaveBeenCalledWith('daily-brief', { body: { force: true } });
});

test('second call for the same user is a no-op', async () => {
  await requestForcedBriefOnce('u1');
  await requestForcedBriefOnce('u1');
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('notifies settled listeners after the call resolves', async () => {
  const fn = jest.fn();
  const off = onForcedBriefSettled(fn);
  await requestForcedBriefOnce('u2');
  expect(fn).toHaveBeenCalledTimes(1);
  off();
});

test('invoke failure is swallowed and still notifies listeners', async () => {
  invoke.mockRejectedValue(new Error('network'));
  const fn = jest.fn();
  onForcedBriefSettled(fn);
  await expect(requestForcedBriefOnce('u3')).resolves.toBeUndefined();
  expect(fn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/lib/__tests__/forced-brief.test.ts`
Expected: FAIL — cannot find module `../forced-brief`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/forced-brief.ts
//
// "First win": fire one on-demand brief generation per user, right after the
// onboarding connect step, so a real brief is waiting on Today instead of an
// empty screen until the next cron window. Fire-and-forget — failures are
// warn-only and never block onboarding.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const forcedBriefKey = (uid: string) => `zolva.${uid}.forced-brief.requested`;

type Listener = () => void;
const listeners = new Set<Listener>();

// TodayScreen subscribes so it can refresh useTodayBrief the moment the
// forced generation settles (success or not — a refresh is harmless).
export function onForcedBriefSettled(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function requestForcedBriefOnce(uid: string): Promise<void> {
  try {
    if ((await AsyncStorage.getItem(forcedBriefKey(uid))) === '1') return;
    await AsyncStorage.setItem(forcedBriefKey(uid), '1');
  } catch {
    // storage failure → proceed; worst case the server dedupes via already-briefed
  }
  try {
    await supabase.functions.invoke('daily-brief', { body: { force: true } });
  } catch (err) {
    if (__DEV__) console.warn('[forced-brief] request failed:', err);
  } finally {
    listeners.forEach((fn) => fn());
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/lib/__tests__/forced-brief.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/forced-brief.ts src/lib/__tests__/forced-brief.test.ts
git commit -m "feat(billing): once-per-user forced first-brief request

- AsyncStorage guard so the force call fires once per user
- settled listener lets Today refresh as soon as generation lands
- all failures swallowed; onboarding never blocks"
```

---

### Task 5: Client — `trial-nudges.ts` logic module

**Files:**
- Create: `src/lib/trial-nudges.ts`
- Create: `src/lib/__tests__/trial-nudges.test.ts`

- [ ] **Step 1: Write the failing tests** (pure logic only — storage/notification wrappers are thin and exercised via the UI tasks)

```typescript
// src/lib/__tests__/trial-nudges.test.ts
import {
  skipperNudgeEligible,
  trialEndingBannerVisible,
  trialEndingFireDate,
  type PitchRecord,
} from '../trial-nudges';
import type { Entitlement } from '../entitlement';

const NOW = new Date('2026-06-10T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

const skipped = (at: string): PitchRecord => ({ at, outcome: 'skipped' });

describe('skipperNudgeEligible', () => {
  const base = { tier: 'free' as const, pitch: skipped(daysAgo(4)), dismissed: false, now: NOW };
  test('eligible: free, skipped ≥3d ago, not dismissed', () => {
    expect(skipperNudgeEligible(base)).toBe(true);
  });
  test('not eligible when tier is not free', () => {
    expect(skipperNudgeEligible({ ...base, tier: 'pro' })).toBe(false);
    expect(skipperNudgeEligible({ ...base, tier: 'lite' })).toBe(false);
  });
  test('not eligible when dismissed', () => {
    expect(skipperNudgeEligible({ ...base, dismissed: true })).toBe(false);
  });
  test('not eligible when pitch missing or started', () => {
    expect(skipperNudgeEligible({ ...base, pitch: null })).toBe(false);
    expect(skipperNudgeEligible({ ...base, pitch: { at: daysAgo(4), outcome: 'started' } })).toBe(false);
  });
  test('not eligible before 3 days', () => {
    expect(skipperNudgeEligible({ ...base, pitch: skipped(daysAgo(2)) })).toBe(false);
    expect(skipperNudgeEligible({ ...base, pitch: skipped(daysAgo(3)) })).toBe(true);
  });
});

const trialEnt = (endsInH: number): Entitlement => ({
  tier: 'pro', isTrial: true,
  trialEndsAt: new Date(NOW.getTime() + endsInH * 3600_000).toISOString(),
  periodEnd: null,
});

describe('trialEndingBannerVisible', () => {
  test('visible inside final 48h', () => {
    expect(trialEndingBannerVisible(trialEnt(47), NOW)).toBe(true);
    expect(trialEndingBannerVisible(trialEnt(1), NOW)).toBe(true);
  });
  test('hidden before final 48h, after expiry, and off-trial', () => {
    expect(trialEndingBannerVisible(trialEnt(49), NOW)).toBe(false);
    expect(trialEndingBannerVisible(trialEnt(-1), NOW)).toBe(false);
    expect(trialEndingBannerVisible(
      { tier: 'pro', isTrial: false, trialEndsAt: null, periodEnd: null }, NOW,
    )).toBe(false);
  });
});

describe('trialEndingFireDate', () => {
  test('T−2d when in the future', () => {
    const ent = trialEnt(72);
    expect(trialEndingFireDate(ent, NOW)?.toISOString())
      .toBe(new Date(NOW.getTime() + 24 * 3600_000).toISOString());
  });
  test('null when T−2d already passed or not on trial', () => {
    expect(trialEndingFireDate(trialEnt(47), NOW)).toBeNull();
    expect(trialEndingFireDate(
      { tier: 'free', isTrial: false, trialEndsAt: null, periodEnd: null }, NOW,
    )).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/lib/__tests__/trial-nudges.test.ts`
Expected: FAIL — cannot find module `../trial-nudges`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/trial-nudges.ts
//
// Trial conversion nudges (billing #4). Pure decision logic lives at the top
// so it's unit-testable; AsyncStorage + expo-notifications wrappers below are
// deliberately thin.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { PAYWALL_RESULT } from 'react-native-purchases-ui';
import type { Entitlement, Tier } from './entitlement';
import { presentPaywall } from './paywall';

export type PitchRecord = { at: string; outcome: 'started' | 'skipped' } | null;

const DAY_MS = 86400_000;
const SKIPPER_MIN_AGE_MS = 3 * DAY_MS;
const TRIAL_BANNER_WINDOW_MS = 2 * DAY_MS;

// --- pure logic -----------------------------------------------------------

export function skipperNudgeEligible(args: {
  tier: Tier;
  pitch: PitchRecord;
  dismissed: boolean;
  now: Date;
}): boolean {
  if (args.tier !== 'free' || args.dismissed) return false;
  if (!args.pitch || args.pitch.outcome !== 'skipped') return false;
  const age = args.now.getTime() - new Date(args.pitch.at).getTime();
  return age >= SKIPPER_MIN_AGE_MS;
}

export function trialEndingBannerVisible(ent: Entitlement, now: Date): boolean {
  if (!ent.isTrial || !ent.trialEndsAt) return false;
  const remaining = new Date(ent.trialEndsAt).getTime() - now.getTime();
  return remaining > 0 && remaining <= TRIAL_BANNER_WINDOW_MS;
}

// T−2 days, or null when that moment has passed / user isn't on trial.
export function trialEndingFireDate(ent: Entitlement, now: Date): Date | null {
  if (!ent.isTrial || !ent.trialEndsAt) return null;
  const fireAt = new Date(new Date(ent.trialEndsAt).getTime() - TRIAL_BANNER_WINDOW_MS);
  return fireAt.getTime() > now.getTime() ? fireAt : null;
}

// --- pitch outcome storage --------------------------------------------------

const pitchKey = (uid: string) => `zolva.${uid}.trial-pitch`;
const skipperDismissKey = (uid: string) => `zolva.${uid}.trial-skipper-nudge.dismissed`;

export async function recordPitchOutcome(uid: string, outcome: 'started' | 'skipped'): Promise<void> {
  try {
    await AsyncStorage.setItem(pitchKey(uid), JSON.stringify({ at: new Date().toISOString(), outcome }));
  } catch {}
}

export async function readPitchRecord(uid: string): Promise<PitchRecord> {
  try {
    const raw = await AsyncStorage.getItem(pitchKey(uid));
    return raw ? (JSON.parse(raw) as PitchRecord) : null;
  } catch {
    return null;
  }
}

export async function markSkipperNudgeDismissed(uid: string): Promise<void> {
  try { await AsyncStorage.setItem(skipperDismissKey(uid), '1'); } catch {}
}

export async function readSkipperNudgeDismissed(uid: string): Promise<boolean> {
  try { return (await AsyncStorage.getItem(skipperDismissKey(uid))) === '1'; } catch { return true; }
}

// --- onboarding pitch -------------------------------------------------------

// Present the trial paywall after the onboarding win. Skippable by design;
// records the outcome so the skipper nudge knows whom to chase.
export async function presentTrialPitch(uid: string | null): Promise<'started' | 'skipped'> {
  if (!uid) return 'skipped'; // not signed in (skipped connect) — gates catch them later
  const result = await presentPaywall();
  const started = result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED;
  const outcome = started ? 'started' : 'skipped';
  await recordPitchOutcome(uid, outcome);
  return outcome;
}

// --- trial-ending local notification ----------------------------------------

const TRIAL_ENDING_NOTIF_ID = 'zolva-trial-ending-2d';

// Idempotent: cancel-then-(re)schedule under a stable identifier, safe to call
// on every entitlement resolution. Off-trial → cancels any pending reminder.
export async function syncTrialEndingNotification(ent: Entitlement): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(TRIAL_ENDING_NOTIF_ID);
  } catch {}
  const fireAt = trialEndingFireDate(ent, new Date());
  if (!fireAt) return;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: TRIAL_ENDING_NOTIF_ID,
      content: {
        title: 'Din Pro-prøveperiode slutter snart',
        body: 'Om 2 dage skifter du til gratis-planen, medmindre du fortsætter med Pro.',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
      },
    });
  } catch (err) {
    if (__DEV__) console.warn('[trial-nudges] schedule failed:', err);
  }
}
```

If jest fails resolving `expo-notifications` or `react-native-purchases-ui` in this module's test, check how `src/lib/__tests__/reminders.test.ts` mocks expo-notifications and add the same `jest.mock(...)` lines to the test file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/lib/__tests__/trial-nudges.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/trial-nudges.ts src/lib/__tests__/trial-nudges.test.ts
git commit -m "feat(billing): trial-nudge logic — pitch outcome, skipper eligibility, trial-ending reminder

- skipper nudge: free tier + skipped pitch ≥3d + not dismissed
- trial-ending banner visible in final 48h; notification at T−2d
- presentTrialPitch wraps paywall + outcome recording"
```

---

### Task 6: Client — onboarding wiring (forced brief + trial pitch)

**Files:**
- Modify: `src/screens/OnboardingFlowScreen.tsx` (`OnboardingFlowScreen` component, ~lines 1734–1746)

- [ ] **Step 1: Wire the trigger and the pitch**

The component already has `useAuth` imported (ScreenActivation uses it). In `OnboardingFlowScreen` (line 1734), get the user and replace `next` (lines 1740–1743):

```typescript
export function OnboardingFlowScreen({ onComplete, onOpenIcloudSetup }: Props) {
  const { user } = useAuth();
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<OnboardingState>(INITIAL_STATE);

  // Screens array index 5 = ScreenTrust (the provider-connect step).
  const TRUST_INDEX = 5;

  const next = () => {
    if (index === TRUST_INDEX && user?.id) {
      // Leaving the connect step: kick off the real first brief in the
      // background so it's waiting on Today after onboarding. Never awaited.
      void requestForcedBriefOnce(user.id);
    }
    if (index < TOTAL_STEPS - 1) {
      setIndex(index + 1);
    } else {
      // Soft trial pitch after the step-7 win, then hand off to the app.
      // presentTrialPitch never throws; outcome drives the skipper nudge.
      void presentTrialPitch(user?.id ?? null).finally(() => onComplete(state));
    }
  };
```

Imports at the top of the file:

```typescript
import { requestForcedBriefOnce } from '../lib/forced-brief';
import { presentTrialPitch } from '../lib/trial-nudges';
```

Verify `useAuth` is already imported in this file (it is used by `ScreenActivation` at line 1492); if the import sits elsewhere, reuse it.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: ONLY the pre-existing TS2322 at `src/lib/hooks.ts:5037`.

- [ ] **Step 3: Commit**

```bash
git add src/screens/OnboardingFlowScreen.tsx
git commit -m "feat(billing): onboarding fires forced brief + soft trial pitch

- leaving the connect step kicks off the on-demand first brief
- completing step 7 presents the skippable Pro-trial paywall before onComplete"
```

---

### Task 7: Client — Today surfaces (skipper card, trial banner, brief refresh)

**Files:**
- Create: `src/components/TrialNudges.tsx`
- Modify: `src/screens/TodayScreen.tsx` (BriefBanner block ~lines 708–717 and imports ~28–38)
- Modify: `src/lib/hooks.ts` (`useEntitlement`, line 215)

- [ ] **Step 1: Create the two surfaces**

Match the visual language of `BriefBanner` / `ProposedActionCard` (read both before writing; use the theme hooks they use — `usePal`/`useTheme` or the `t`/`surface` tokens, whichever those components actually import):

```tsx
// src/components/TrialNudges.tsx
//
// Billing #4 conversion surfaces on the Today feed:
// - SkipperNudgeCard: one-time "try Pro" card for users who skipped the
//   onboarding pitch ≥3 days ago and are still on free.
// - TrialEndingBanner: shown during the final 48h of a Pro trial.

import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useEntitlement } from '../lib/hooks';
import { presentPaywallIfNeeded } from '../lib/paywall';
import {
  markSkipperNudgeDismissed,
  readPitchRecord,
  readSkipperNudgeDismissed,
  skipperNudgeEligible,
  trialEndingBannerVisible,
} from '../lib/trial-nudges';

export function SkipperNudgeCard() {
  const { user } = useAuth();
  const { data: ent } = useEntitlement();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const uid = user?.id;
    if (!uid || !ent) {
      setVisible(false);
      return;
    }
    (async () => {
      const [pitch, dismissed] = await Promise.all([
        readPitchRecord(uid),
        readSkipperNudgeDismissed(uid),
      ]);
      if (cancelled) return;
      setVisible(skipperNudgeEligible({ tier: ent.tier, pitch, dismissed, now: new Date() }));
    })();
    return () => { cancelled = true; };
  }, [user?.id, ent]);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    if (user?.id) void markSkipperNudgeDismissed(user.id);
  };

  return (
    <View accessibilityLabel="trial-skipper-nudge" /* style per BriefBanner card pattern */>
      <Text>Zolva har holdt øje for dig i et par dage</Text>
      <Text>Prøv Pro gratis — autonome handlinger, ubegrænset chat og mere.</Text>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Pressable
          accessibilityLabel="Prøv Pro"
          onPress={() => {
            void presentPaywallIfNeeded('pro').then((entitled) => {
              if (entitled) dismiss();
            });
          }}
        >
          <Text>Prøv Pro</Text>
        </Pressable>
        <Pressable accessibilityLabel="Nej tak" onPress={dismiss}>
          <Text>Nej tak</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function TrialEndingBanner() {
  const { data: ent } = useEntitlement();
  if (!ent || !trialEndingBannerVisible(ent, new Date())) return null;
  return (
    <View accessibilityLabel="trial-ending-banner" /* style per BriefBanner */>
      <Text>Din Pro-prøveperiode slutter om mindre end 2 dage.</Text>
    </View>
  );
}
```

The `/* style per ... */` comments are instructions to the implementer, not shippable code: copy the concrete card/banner styling from `BriefBanner` (`src/components/BriefBanner.tsx`) so the surfaces match the feed. Remove the comments in the final code.

- [ ] **Step 2: Mount in TodayScreen + forced-brief refresh**

In `src/screens/TodayScreen.tsx`, add imports:

```typescript
import { SkipperNudgeCard, TrialEndingBanner } from '../components/TrialNudges';
import { onForcedBriefSettled } from '../lib/forced-brief';
```

Render directly below the BriefBanner block (after line 717):

```tsx
        <TrialEndingBanner />
        <SkipperNudgeCard />
```

And inside the component body (next to the existing foreground-refresh effect around line 139), refresh the brief when the forced generation settles — `useTodayBrief` already returns `refresh`:

```typescript
  useEffect(() => onForcedBriefSettled(() => { void refreshBrief(); }), [refreshBrief]);
```

(Use the actual local name TodayScreen destructures for `refresh` from `useTodayBrief` — check the destructuring near line 161.)

- [ ] **Step 3: Sync the trial-ending notification in `useEntitlement`**

In `src/lib/hooks.ts` (`useEntitlement`, line 215): after the hook resolves/updates its `Entitlement` value (wherever `setData`/state-set happens, including the CustomerInfo listener path), add:

```typescript
      void syncTrialEndingNotification(resolved);
```

with `import { syncTrialEndingNotification } from './trial-nudges';` at the top. The function is idempotent (cancel-then-schedule under a stable id), so calling it on every resolution is safe.

- [ ] **Step 4: Typecheck + full client suite**

Run: `npm run typecheck && npx jest`
Expected: only the pre-existing TS2322 at hooks.ts:5037; all jest suites green.

- [ ] **Step 5: Commit**

```bash
git add src/components/TrialNudges.tsx src/screens/TodayScreen.tsx src/lib/hooks.ts
git commit -m "feat(billing): Today nudge surfaces + trial-ending notification sync

- SkipperNudgeCard: one-time Pro pitch for free users who skipped, ≥3d
- TrialEndingBanner during final 48h of trial
- useEntitlement keeps the T−2d local notification in sync
- Today refreshes the brief when the forced first-brief call settles"
```

---

### Task 8: Full verification + wrap-up — CHECKPOINT

- [ ] **Step 1: Run everything**

```bash
deno test supabase/functions/daily-brief/
npx jest
npm run typecheck
```

Expected: all server + client tests green; typecheck shows only hooks.ts:5037 TS2322.

- [ ] **Step 2: Verify nothing unintended is staged/dirty**

`git status --short` — only the five known pre-existing dirty files (`app.json`, `package.json`, `package-lock.json`, `deno.lock`, `.gitignore`) should remain modified-unstaged.

- [ ] **Step 3: STOP — report to the user**

Device verification (real onboarding run with a fresh account, paywall presentation, notification scheduling) needs a dev build, not Expo Go. Hand back for the user to decide on device QA + OTA timing. Do NOT run `eas update` or push without instruction.
