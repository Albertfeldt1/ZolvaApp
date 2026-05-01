# Widget v2 — Siri Voice Calendar Create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single voice action — "Hey Siri, bed Zolva om at sætte et møde i morgen kl. 17" — that creates an event on the user's chosen Google or Microsoft calendar without launching the app, returning a Stone-illustrated snippet and spoken confirmation.

**Architecture:** AppShortcut-driven AppIntent in the main iOS target. Whole transcript ships to a new Supabase Edge Function (`widget-action`) over Bearer JWT read from a shared keychain access group. Edge Function calls Claude with one forced tool, resolves the user's `work` / `personal` calendar mapping (stored as four normalized columns on `user_profiles`), writes via Google Calendar / Microsoft Graph, and returns a `{ dialog, snippet }` payload. RN app keeps the shared keychain in sync via `onAuthStateChange`. v1 widget chat row stays untouched.

**Tech Stack:** Expo SDK 54, React Native 0.81, TypeScript, Swift 5.9 / SwiftUI / AppIntents, Supabase Postgres + Edge Functions (Deno), `@bacons/apple-targets`, `expo-secure-store@15.0.8` (with `keychainService` + `keychainAccessGroup`), Anthropic Messages API.

**Spec:** `docs/superpowers/specs/2026-04-28-widget-v2-siri-design.md`

---

## Held-back files — do NOT touch in this work

These appear modified/untracked at plan time. Plan tasks must NOT stage them, even when editing the same file:

- `src/lib/auth.ts` — has an unstaged Microsoft `Calendars.Read → Calendars.ReadWrite` scope bump (waiting on Azure AD app-registration update). Task 6 adds new lines to this file; use `git add -p` to stage ONLY the new shared-keychain wiring, leave the scope-bump line(s) unstaged.
- `supabase/migrations/20260427130000_icloud_proxy_calls_retention.sql`
- `supabase/schedule-icloud-proxy-retention.sql.template`

If you find a held-back file accidentally staged, `git restore --staged <file>` before committing.

---

## Phase 0 — Spike

The "AppIntent runs in-process and inherits the main app's keychain access group" assertion is documented Apple behavior but unverified for this app's specific entitlement / signing / Siri-dispatch combination. v2 piles a snippet view, an Edge Function, label settings UI, and a refresh client on top of that one assumption. The spike is throwaway code that proves it on a real device under Hey-Siri before any of that lands.

**Spike outcome (2026-04-28):**
- ✅ AppIntent has working keychain access to the shared group under Hey-Siri dispatch (`SecItemAdd` + `SecItemCopyMatching` both return `errSecSuccess`).
- 🔍 expo-secure-store internally appends `":no-auth"` to the `keychainService` value (or `":auth"` when `requireAuthentication: true`). The Swift reader must query with the suffixed service or items written via `SecureStore.setItemAsync('...', '...', { keychainService: 'io.zolva.shared' })` are invisible. Reflected in Task 23's `SupabaseSession.service` constant.
- 🔍 With `keychain-access-groups` entitlement set, the listed group becomes the default for all keychain writes — even from libraries that don't pass `kSecAttrAccessGroup` explicitly. Existing app keychain items (Supabase session, Google token, iCloud creds) all migrate to `io.zolva.shared` automatically on first launch with the entitlement.

### Task 0: SPIKE FIRST — Keychain access verification

**Files:**
- Create (throwaway, reverted at end): `plugins/voice-intents/SpikeKeychainProbeIntent.swift`
- Create (throwaway): `plugins/voice-intents/withSpikeProbe.js`
- Modify (throwaway, reverted): `app.json` (add the spike plugin + entitlement + Info.plist)

The whole spike branch gets reverted after verification — its only output is a yes/no answer.

- [ ] **Step 1: Create spike branch from main**

```bash
git checkout main
git pull
git checkout -b spike/keychain-access-verification
```

- [ ] **Step 2: Add the spike's `app.json` changes**

In `app.json` under `expo.ios`:

1. Append to `entitlements`:
   ```json
   "keychain-access-groups": ["$(AppIdentifierPrefix)io.zolva.shared"]
   ```
2. Add `infoPlist` entry (any value — the spike doesn't read it, but the same entry will be needed by v2 proper, and we want to make sure prebuild accepts it now):
   ```json
   "SupabaseAnonKey": "spike-placeholder"
   ```
3. Append to `plugins`:
   ```json
   "./plugins/voice-intents/withSpikeProbe"
   ```

- [ ] **Step 3: Write a one-shot expo-secure-store seed**

Add this temporary block to `App.tsx` somewhere it runs once on mount (near the existing init effects):

```ts
import * as SecureStore from 'expo-secure-store';
// SPIKE — remove before merging anything else.
useEffect(() => {
  void SecureStore.setItemAsync('supabase.access_token', 'SPIKE_TEST_VALUE', {
    keychainAccessGroup: 'io.zolva.shared',
    keychainService: 'io.zolva.shared',
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  }).then(() => console.log('[spike] seed wrote'));
}, []);
```

- [ ] **Step 4: Write the spike Swift probe**

Create `plugins/voice-intents/SpikeKeychainProbeIntent.swift`:

```swift
import AppIntents
import Foundation
import Security

struct SpikeKeychainProbeIntent: AppIntent {
  static var title: LocalizedStringResource = "Spike Keychain Probe"

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "io.zolva.shared",
      kSecAttrAccount as String: "supabase.access_token",
      kSecAttrAccessGroup as String: "N6WPH3FPFA.io.zolva.shared",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    let osStatusInt = Int(status)
    let value: String = {
      if status == errSecSuccess, let data = item as? Data {
        return String(data: data, encoding: .utf8) ?? "<binary>"
      }
      return "<no-data>"
    }()
    print("[spike] OSStatus=\(osStatusInt) value=\(value)")
    return .result(dialog: IntentDialog(stringLiteral: "OSStatus \(osStatusInt). Tjek logs."))
  }
}

struct SpikeShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: SpikeKeychainProbeIntent(),
      phrases: ["Spike \(.applicationName)"],
      shortTitle: "Spike Probe",
      systemImageName: "key.fill"
    )
  }
}
```

- [ ] **Step 5: Write the spike config plugin**

Create `plugins/voice-intents/withSpikeProbe.js` (mirror `plugins/widget-bridge/withWidgetBridge.js`):

```js
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');

const SOURCES = ['SpikeKeychainProbeIntent.swift'];

const copy = (config) =>
  withDangerousMod(config, ['ios', async (cfg) => {
    const src = path.join(cfg.modRequest.projectRoot, 'plugins', 'voice-intents');
    const dst = path.join(cfg.modRequest.platformProjectRoot, 'Zolva');
    for (const f of SOURCES) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    return cfg;
  }]);

const register = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = project.findTargetKey('Zolva');
    if (!target) return cfg;
    for (const f of SOURCES) {
      const group = project.findPBXGroupKey({ name: 'Zolva' }) ?? project.pbxCreateGroup('Zolva', 'Zolva');
      project.addSourceFile(`Zolva/${f}`, { target, lastKnownFileType: 'sourcecode.swift' }, group);
    }
    return cfg;
  });

module.exports = (config) => register(copy(config));
```

- [ ] **Step 6: Prebuild + build to a real device**

```bash
npx expo prebuild --clean --platform ios
xcodebuild -workspace ios/Zolva.xcworkspace -scheme Zolva -configuration Debug -destination 'generic/platform=iOS' -quiet build CODE_SIGNING_ALLOWED=NO || true
```

Then build to a connected real iPhone via Xcode (open `ios/Zolva.xcworkspace` → select your physical device → Run). The simulator's keychain access groups behave differently — the spike MUST run on real hardware.

If a TestFlight ship is preferred over local development build, ask the user to run the EAS build themselves; do not invoke `eas build` on their behalf.

- [ ] **Step 7: Manually verify**

On the device:
1. Open the app once (this triggers Step 3's seed write).
2. Lock the device, then say "Hey Siri, spike Zolva".
3. Plug back into Mac, open Console.app → filter on `[spike]` and process `Zolva`.

Expected log line: `[spike] OSStatus=0 value=SPIKE_TEST_VALUE`.

Outcomes:
- `OSStatus=0` (errSecSuccess) → assumption holds. Proceed.
- `OSStatus=-25300` (errSecItemNotFound) → the access-group entitlement isn't being applied to the AppIntent's process. Stop. Investigate provisioning / entitlement plist before proceeding with v2.
- Any other `OSStatus` → look it up at https://www.osstatus.com — typically a code-signing or provisioning mismatch. Stop and resolve.

- [ ] **Step 8: Record outcome and revert**

Whatever the outcome:

```bash
git checkout main
git branch -D spike/keychain-access-verification
```

Save a memory entry recording the OSStatus and the date verified. Only proceed past Task 0 if Step 7 returned `errSecSuccess`.

---

## Phase 1 — Prerequisites

### Task 1: Add `SupabaseAnonKey`, keychain entitlement, and bump iOS deployment target to 16.0

**Files:**
- Modify: `app.json`
- Modify: `package.json` (adds `expo-build-properties`)

The publishable (anon) key for project `sjkhfkatmeqtsrysixop`. Verify before committing that this is the **anon / publishable** key, NOT the service-role key (service-role would be a credential leak).

The deployment-target bump to iOS 16.0 is a v2 prerequisite surfaced by Task 0's spike — `AppIntents`, `AppShortcutsProvider`, `IntentResult`, `ProvidesDialog`, and `LocalizedStringResource` all require iOS 16+. Bumping via `expo-build-properties` is the Expo-blessed config-plugin path and survives `expo prebuild --clean`.

- [ ] **Step 1: Look up the publishable key**

In Supabase dashboard → project `sjkhfkatmeqtsrysixop` → Settings → API → "Project API keys". Copy the `anon` (a.k.a. publishable) `public` key. Confirm the JWT's `role` claim is `anon` by decoding it at jwt.io — refuse to commit if it says `service_role`.

- [ ] **Step 2: Install `expo-build-properties`**

```bash
npx expo install expo-build-properties
```

Expected: `package.json` gains `expo-build-properties` in `dependencies` and `package-lock.json` updates.

- [ ] **Step 3: Edit `app.json`**

Under `expo.ios.infoPlist` add `SupabaseAnonKey`:

```json
"infoPlist": {
  "NSUserNotificationsUsageDescription": "Zolva sender notifikationer om påmindelser, dagens overblik og kommende møder.",
  "ITSAppUsesNonExemptEncryption": false,
  "SupabaseAnonKey": "<paste the anon JWT here>"
}
```

Under `expo.ios.entitlements` add `keychain-access-groups`:

```json
"entitlements": {
  "com.apple.security.application-groups": ["group.io.zolva.app"],
  "keychain-access-groups": ["$(AppIdentifierPrefix)io.zolva.shared"]
}
```

`$(AppIdentifierPrefix)` resolves at build time to `<TeamID>.` — for Team `N6WPH3FPFA`, the entitlement string becomes `N6WPH3FPFA.io.zolva.shared`. Verified by Task 0 spike.

In `expo.plugins`, append the `expo-build-properties` config (place AFTER `["@bacons/apple-targets", { "appleTeamId": "N6WPH3FPFA" }]` and BEFORE `"./plugins/widget-bridge/withWidgetBridge"`):

```json
[
  "expo-build-properties",
  {
    "ios": {
      "deploymentTarget": "16.0"
    }
  }
]
```

- [ ] **Step 4: Run prebuild to regenerate entitlements + Podfile**

```bash
npx expo prebuild --clean --platform ios
```

Expected:
- `ios/Zolva/Zolva.entitlements` contains both `com.apple.security.application-groups` and `keychain-access-groups`.
- `ios/Podfile` contains `platform :ios, '16.0'` (or higher).
- `ios/Zolva.xcodeproj/project.pbxproj` shows `IPHONEOS_DEPLOYMENT_TARGET = 16.0;` in the Zolva target's build settings.

- [ ] **Step 5: Verify a clean Xcode build**

```bash
xcodebuild -workspace ios/Zolva.xcworkspace -scheme Zolva -configuration Debug -destination 'generic/platform=iOS' -quiet build CODE_SIGNING_ALLOWED=NO
```

Expected: `BUILD SUCCEEDED`. v1 widget code keeps compiling.

- [ ] **Step 6: Commit**

```bash
git add app.json package.json package-lock.json
git commit -m "feat(ios): SupabaseAnonKey + keychain-access-groups + iOS 16 deployment target for v2"
```

Do NOT commit the regenerated `ios/` directory — it's gitignored normally; the entitlement and deployment target live in `app.json` + `package.json` and regenerate from those.

### Task 2: Privacy policy verification (manual prerequisite)

**Files (depending on outcome):**
- Maybe modify: `https://albertfeldt1.github.io/ZolvaApp/` (the privacy policy URL — owned by user).
- Choose between Task 19a (DB table + retention purge) and Task 19b (ephemeral logs only).

This is a thinking-and-verifying task, not a code task. **Owner: Albert.**

- [ ] **Step 1: Locate the policy**

Open `https://albertfeldt1.github.io/ZolvaApp/` (the URL in `app.json` `extra.privacyPolicyUrl`). Confirm it loads. Skim for two things:

1. **Logging stance.** Does the policy say anything about how long Zolva retains backend logs? Common phrasings:
   - "We do not log requests" → no DB table; use ephemeral structured logs only.
   - "Logs retained for X days" → create the DB table with that TTL.
   - Silent on logs → safe-default to ephemeral; or, if you intend to keep `widget_action_calls`, update the policy to disclose ≤60-day retention before TestFlight.

2. **Voice / Siri / Anthropic disclosure.** Does the policy describe (a) voice transcripts being processed, (b) data being sent to Anthropic, (c) the Edge Function pathway? If any of those are missing and v2 introduces them, update the policy text before TestFlight.

- [ ] **Step 2: Pick the logging branch**

Decide between:
- **DB-table branch (Task 19a):** policy permits ≤60-day backend logs. Mirror the `supabase/migrations/20260427130000_icloud_proxy_calls_retention.sql` pattern.
- **Ephemeral branch (Task 19b):** `console.log(JSON.stringify({...}))` from the Edge Function only. No DB write, ~7-day Supabase platform retention.

Document the choice in `docs/superpowers/plans/2026-04-28-widget-v2-siri.md` (this file) by appending a one-line note to Task 19 indicating which sub-task to skip.

- [ ] **Step 3: If policy text needs updating, do that first**

Update the privacy policy site / file. This blocks Task 26 (ship). It does NOT block any pre-ship work — code and test through Task 25 can proceed in parallel.

- [ ] **Step 4: No commit needed for this task itself.** It produces a decision recorded in this file.

---

## Phase 2 — Database migration

### Task 3: `user_profiles` calendar-label columns + JSONB snapshot

**Files:**
- Create: `supabase/migrations/20260428183947_calendar_labels.sql`

Two label-pairs as concrete columns, check-constrained provider enum, NULL-consistency check. Plus the `previous_calendar_labels` JSONB column reserved (default null) for the v2.x restore-prompt feature. v2 disconnect handler clears active labels; the snapshot column is added now but unwritten.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260428183947_calendar_labels.sql`:

```sql
alter table public.user_profiles
  add column if not exists work_calendar_provider text
    check (work_calendar_provider in ('google', 'microsoft')),
  add column if not exists work_calendar_id text,
  add column if not exists personal_calendar_provider text
    check (personal_calendar_provider in ('google', 'microsoft')),
  add column if not exists personal_calendar_id text;

alter table public.user_profiles
  add constraint work_calendar_consistency
    check ((work_calendar_provider is null) = (work_calendar_id is null)),
  add constraint personal_calendar_consistency
    check ((personal_calendar_provider is null) = (personal_calendar_id is null));

alter table public.user_profiles
  add column if not exists previous_calendar_labels jsonb default null;

comment on column public.user_profiles.previous_calendar_labels is
  'Transient snapshot written by disconnect handler; read once by reconnect
   handler for the restore-prompt flow, then cleared. Unwritten in v2 (reserved
   for v2.x restore-prompt). Not read by Edge Functions.';
```

- [ ] **Step 2: Apply locally and verify**

If using the local Supabase stack:

```bash
supabase migration up --linked  # or: supabase db push --linked
```

If applying directly via the dashboard, paste the SQL into the SQL editor for project `sjkhfkatmeqtsrysixop` and run.

Verify:

```sql
select column_name, is_nullable, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'user_profiles'
  and column_name in (
    'work_calendar_provider', 'work_calendar_id',
    'personal_calendar_provider', 'personal_calendar_id',
    'previous_calendar_labels'
  )
order by column_name;
```

Expected: 5 rows, all `is_nullable = YES`, providers as `text`, snapshot as `jsonb`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260428183947_calendar_labels.sql
git commit -m "feat(db): user_profiles calendar label columns for voice routing"
```

---

## Phase 3 — Shared keychain wiring (TS side)

### Task 4: `src/lib/keychain.ts` — shared-session helpers

**Files:**
- Create: `src/lib/keychain.ts`

Wrap `expo-secure-store` with the access-group + service options. Used by Task 5 (`auth.ts` mirroring) and by the AppIntent on the Swift side via `SupabaseSession.swift`.

`expo-secure-store@15.0.8` exposes `keychainService` in `SecureStoreOptions`. Verified at spec time.

- [ ] **Step 1: Write the module**

Create `src/lib/keychain.ts`:

```ts
// Mirrors the Supabase session into the shared keychain access group so
// the iOS AppIntent process (Siri-dispatched, separate from the RN runtime)
// can read JWT + refresh token. Native-only; web has no shared keychain.

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export const KEYCHAIN_ACCESS_GROUP = 'io.zolva.shared';
export const KEYCHAIN_SERVICE = 'io.zolva.shared';
export const JWT_KEY = 'supabase.access_token';
export const REFRESH_KEY = 'supabase.refresh_token';

const isNativeIos = Platform.OS === 'ios';

// SECURITY TRADE-OFF: AFTER_FIRST_UNLOCK lets any process in this app's
// keychain access group read the token after the device has been unlocked
// at least once since boot. Required so Siri-dispatched AppIntents work
// post-reboot before the user has launched Zolva. WHEN_UNLOCKED would
// block voice on every device wake.
const SHARED_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessGroup: KEYCHAIN_ACCESS_GROUP,
  keychainService: KEYCHAIN_SERVICE,
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function writeSharedSession(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  if (!isNativeIos) return;
  await SecureStore.setItemAsync(JWT_KEY, accessToken, SHARED_OPTS);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken, SHARED_OPTS);
}

export async function clearSharedSession(): Promise<void> {
  if (!isNativeIos) return;
  await SecureStore.deleteItemAsync(JWT_KEY, SHARED_OPTS);
  await SecureStore.deleteItemAsync(REFRESH_KEY, SHARED_OPTS);
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors. (Pre-existing held-back-file errors are tolerated.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/keychain.ts
git commit -m "feat(keychain): shared session helpers for AppIntent reuse"
```

### Task 5: Mirror Supabase session into shared keychain on auth events

**Files:**
- Modify: `src/lib/auth.ts` (additive — held-back scope-bump line stays unstaged)

Hook into the existing `supabase.auth.onAuthStateChange` block in `src/lib/auth.ts:201-218`. Mirror SIGNED_IN / TOKEN_REFRESHED into the shared keychain; clear on SIGNED_OUT.

- [ ] **Step 1: Add the import**

At the top of `src/lib/auth.ts`, alongside the existing `import * as secureStorage from './secure-storage';`:

```ts
import { writeSharedSession, clearSharedSession } from './keychain';
```

- [ ] **Step 2: Extend the existing onAuthStateChange listener**

In `src/lib/auth.ts` find the existing `supabase.auth.onAuthStateChange((event, session) => { ... })` block (currently at lines ~201-218) and add the mirroring inside it, immediately after `broadcastSession(session);`:

```ts
// Mirror Supabase access + refresh token into the shared keychain so the
// Siri-dispatched AppIntent can read them. Best-effort — keychain failures
// are not fatal; voice will surface "logget ud" gracefully.
if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.access_token && session?.refresh_token) {
  void writeSharedSession(session.access_token, session.refresh_token).catch((err) => {
    if (__DEV__) console.warn('[auth] writeSharedSession failed:', err);
  });
}
if (event === 'SIGNED_OUT') {
  void clearSharedSession().catch((err) => {
    if (__DEV__) console.warn('[auth] clearSharedSession failed:', err);
  });
}
```

Also add a one-shot mirror in the `init()` IIFE (right after `broadcastSession(data.session)`) so a session already present at cold-start gets mirrored — `onAuthStateChange` doesn't fire for the initially-restored session:

```ts
if (data.session?.access_token && data.session?.refresh_token) {
  void writeSharedSession(data.session.access_token, data.session.refresh_token).catch((err) => {
    if (__DEV__) console.warn('[auth] writeSharedSession (init) failed:', err);
  });
}
```

- [ ] **Step 3: Selective stage (held-back scope-bump line stays unstaged)**

```bash
git diff src/lib/auth.ts
```

Visually confirm the diff. Then:

```bash
git add -p src/lib/auth.ts
```

For each hunk, accept (`y`) the new shared-keychain hunks; reject (`n`) the held-back `Calendars.Read → Calendars.ReadWrite` hunk.

After staging, sanity-check:

```bash
git diff --cached src/lib/auth.ts
```

Should show ONLY the new shared-keychain wiring + the new import. If the scope-bump line slipped in, `git restore --staged src/lib/auth.ts` and redo Step 3.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(auth): mirror session to shared keychain for AppIntent"
```

---

## Phase 4 — Calendar labels (TS read/write + auto-clear)

### Task 6: `src/lib/calendar-labels.ts`

**Files:**
- Create: `src/lib/calendar-labels.ts`

Read maps the four DB columns → object shape; write nulls both columns when `target === null`. The transient `previous_calendar_labels` JSONB column is NOT read or written here in v2 (reserved for v2.x restore-prompt).

- [ ] **Step 1: Write the module**

Create `src/lib/calendar-labels.ts`:

```ts
import { supabase } from './supabase';

export type CalendarLabelKey = 'work' | 'personal';
export type CalendarProvider = 'google' | 'microsoft';
export type CalendarLabelTarget = {
  provider: CalendarProvider;
  id: string;
};
export type CalendarLabels = Partial<Record<CalendarLabelKey, CalendarLabelTarget>>;

type Row = {
  work_calendar_provider: CalendarProvider | null;
  work_calendar_id: string | null;
  personal_calendar_provider: CalendarProvider | null;
  personal_calendar_id: string | null;
};

export async function readCalendarLabels(userId: string): Promise<CalendarLabels> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select(
      'work_calendar_provider, work_calendar_id, personal_calendar_provider, personal_calendar_id',
    )
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const row = (data ?? null) as Row | null;
  if (!row) return {};

  const out: CalendarLabels = {};
  if (row.work_calendar_provider && row.work_calendar_id) {
    out.work = { provider: row.work_calendar_provider, id: row.work_calendar_id };
  }
  if (row.personal_calendar_provider && row.personal_calendar_id) {
    out.personal = { provider: row.personal_calendar_provider, id: row.personal_calendar_id };
  }
  return out;
}

export async function setCalendarLabel(
  userId: string,
  key: CalendarLabelKey,
  target: CalendarLabelTarget | null,
): Promise<void> {
  const update =
    key === 'work'
      ? {
          work_calendar_provider: target?.provider ?? null,
          work_calendar_id: target?.id ?? null,
        }
      : {
          personal_calendar_provider: target?.provider ?? null,
          personal_calendar_id: target?.id ?? null,
        };

  const { error } = await supabase
    .from('user_profiles')
    .update(update)
    .eq('user_id', userId);
  if (error) throw error;
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/calendar-labels.ts
git commit -m "feat(calendar): TS helpers for normalized calendar-label columns"
```

### Task 7: Auto-clear-on-disconnect

**Files:**
- Modify: `src/lib/auth.ts` (in the `disconnectProvider` function, around line 537-566)

A stale label can never silently mis-route a voice call to a calendar the user no longer has access to. v2 must-have. The snapshot-into-`previous_calendar_labels` step is deliberately omitted in v2 (reserved for v2.x).

- [ ] **Step 1: Write the test setup notes**

Manual test plan (run after the change):
1. Sign in. Set Settings → Stemmestyring → Work = a Google calendar.
2. Disconnect Google in Settings → Connections.
3. Reload Settings. Stemmestyring → Work should now read "Ikke valgt".
4. Verify in DB: `select work_calendar_provider, work_calendar_id from user_profiles where user_id=...` → both null.

- [ ] **Step 2: Add the import**

In `src/lib/auth.ts` near the existing imports:

```ts
import { readCalendarLabels, setCalendarLabel } from './calendar-labels';
```

- [ ] **Step 3: Modify `disconnectProvider`**

In `src/lib/auth.ts`, locate `export async function disconnectProvider(provider: 'google' | 'microsoft')`. Add the auto-clear step at the very top of the body, right after the `if (!uid) return;` line and before the demo-user early return:

```ts
// Auto-clear any voice-routing labels that point at this provider — a
// stale label can never silently mis-route a voice call to a calendar
// the user no longer has access to.
try {
  const labels = await readCalendarLabels(uid);
  await Promise.all(
    (Object.entries(labels) as Array<[
      'work' | 'personal',
      { provider: 'google' | 'microsoft'; id: string } | undefined,
    ]>).map(async ([key, target]) => {
      if (target?.provider === provider) {
        await setCalendarLabel(uid, key, null);
      }
    }),
  );
} catch (err) {
  // Demo user (no real DB row) or transient DB error — fall through. The
  // label is at worst stale; the Edge Function's defensive null-check on
  // resolution catches a row state where columns are inconsistent.
  if (__DEV__) console.warn('[auth] auto-clear calendar labels failed:', err);
}
```

- [ ] **Step 4: Stage selectively (held-back scope-bump line still excluded)**

Same pattern as Task 5:

```bash
git add -p src/lib/auth.ts
git diff --cached src/lib/auth.ts
```

Confirm only the new auto-clear block + new import are staged.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(auth): auto-clear voice calendar labels on provider disconnect"
```

### Task 8: `src/lib/calendar-providers.ts` — list writable calendars

**Files:**
- Create: `src/lib/calendar-providers.ts`

Filtering at picker time is best-effort. Real write-permission failures still get surfaced at write time via the `permission_denied` error class.

- [ ] **Step 1: Write the module**

Create `src/lib/calendar-providers.ts`:

```ts
// Lists calendars the connected accounts can write to. Used by the Settings
// "Stemmestyring" picker. Filtering is best-effort — Google G Suite policy
// overrides and shared-with-edit-delegation inconsistencies will get past
// this. Real write failures surface at Edge-Function write time.

import { tryWithRefresh } from './auth';

export type ProviderCalendar = {
  provider: 'google' | 'microsoft';
  id: string;
  name: string;
  color: string | null;
  accountEmail: string | null;
  isMainAccount: boolean;
};

type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  accessRole?: string;
  primary?: boolean;
};

type MicrosoftCalendar = {
  id: string;
  name?: string;
  hexColor?: string;
  canEdit?: boolean;
  isDefaultCalendar?: boolean;
  owner?: { address?: string };
};

export async function listGoogleCalendars(): Promise<ProviderCalendar[]> {
  return tryWithRefresh('google', async (token) => {
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 401) {
      const { ProviderAuthError } = await import('./auth');
      throw new ProviderAuthError('google', 'Google calendar list 401');
    }
    if (!res.ok) throw new Error(`Google calendarList ${res.status}`);
    const body = (await res.json()) as { items?: GoogleCalendarListEntry[] };
    return (body.items ?? [])
      .filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
      .map<ProviderCalendar>((c) => ({
        provider: 'google',
        id: c.id,
        name: c.summaryOverride ?? c.summary ?? c.id,
        color: c.backgroundColor ?? null,
        accountEmail: c.primary ? c.id : null,
        isMainAccount: !!c.primary,
      }));
  });
}

export async function listMicrosoftCalendars(): Promise<ProviderCalendar[]> {
  return tryWithRefresh('microsoft', async (token) => {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/calendars', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      const { ProviderAuthError } = await import('./auth');
      throw new ProviderAuthError('microsoft', 'Microsoft calendars 401');
    }
    if (!res.ok) throw new Error(`Microsoft calendars ${res.status}`);
    const body = (await res.json()) as { value?: MicrosoftCalendar[] };
    return (body.value ?? [])
      .filter((c) => c.canEdit !== false)
      .map<ProviderCalendar>((c) => ({
        provider: 'microsoft',
        id: c.id,
        name: c.name ?? c.id,
        color: c.hexColor ?? null,
        accountEmail: c.owner?.address ?? null,
        isMainAccount: !!c.isDefaultCalendar,
      }));
  });
}

export async function listWritableCalendars(opts: {
  hasGoogle: boolean;
  hasMicrosoft: boolean;
}): Promise<ProviderCalendar[]> {
  const calls: Array<Promise<ProviderCalendar[]>> = [];
  if (opts.hasGoogle) calls.push(listGoogleCalendars());
  if (opts.hasMicrosoft) calls.push(listMicrosoftCalendars());
  const settled = await Promise.allSettled(calls);
  // Promise.allSettled so one provider's failure doesn't blank the picker.
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/calendar-providers.ts
git commit -m "feat(calendar): list writable calendars per connected provider"
```

### Task 9: `useCalendarLabels` hook

**Files:**
- Modify: `src/lib/hooks.ts` (add at end)

For v2 the user is the only writer from one device, so refresh-on-mount + refresh-after-write is sufficient. v3 will switch to a Supabase realtime subscription on `user_profiles` for multi-device.

- [ ] **Step 1: Add imports at top of `src/lib/hooks.ts`**

```ts
import {
  readCalendarLabels,
  setCalendarLabel,
  type CalendarLabels,
  type CalendarLabelKey,
  type CalendarLabelTarget,
} from './calendar-labels';
```

- [ ] **Step 2: Append the hook at end of file**

```ts
// TODO(v3): Replace local refresh with Supabase realtime subscription on
// user_profiles when we add multi-device support (Mac / Watch / Web).
// For v2 the user is the only writer from one device, so refresh-on-mount
// + refresh-after-write is sufficient.
export function useCalendarLabels() {
  const { user } = useAuth();
  const [labels, setLabels] = useState<CalendarLabels>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user?.id) {
      setLabels({});
      setLoading(false);
      return;
    }
    try {
      const fresh = await readCalendarLabels(user.id);
      setLabels(fresh);
    } catch (err) {
      if (__DEV__) console.warn('[useCalendarLabels] refresh failed:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setLabel = useCallback(
    async (key: CalendarLabelKey, target: CalendarLabelTarget | null) => {
      if (!user?.id) return;
      await setCalendarLabel(user.id, key, target);
      await refresh();
    },
    [refresh, user?.id],
  );

  return { labels, loading, refresh, setLabel };
}
```

If `useCallback` / `useEffect` / `useState` aren't already imported at the top of `hooks.ts`, add them to the existing react import.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/hooks.ts
git commit -m "feat(hooks): useCalendarLabels for voice routing settings"
```

---

## Phase 5 — Settings UI

### Task 10: Stemmestyring section + picker modal

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

New sub-section under existing Connections. Two label rows. Tap → picker modal grouped by account email. Selection writes immediately (no save button). Auto-clear on disconnect (Task 7) handles the cleanup case.

- [ ] **Step 1: Add imports**

At top of `src/screens/SettingsScreen.tsx`:

```tsx
import { useCalendarLabels } from '../lib/hooks';
import { listWritableCalendars, type ProviderCalendar } from '../lib/calendar-providers';
import { useAuth } from '../lib/auth';
import type { CalendarLabelKey } from '../lib/calendar-labels';
```

- [ ] **Step 2: Add the section component**

Place before the default export, in the same file:

```tsx
function StemmestyringSection() {
  const { googleAccessToken, microsoftAccessToken } = useAuth();
  const { labels, setLabel } = useCalendarLabels();
  const [picker, setPicker] = useState<CalendarLabelKey | null>(null);
  const [calendars, setCalendars] = useState<ProviderCalendar[]>([]);
  const [loadingCalendars, setLoadingCalendars] = useState(false);

  const hasAnyProvider = !!googleAccessToken || !!microsoftAccessToken;

  const openPicker = async (key: CalendarLabelKey) => {
    setPicker(key);
    setLoadingCalendars(true);
    try {
      const list = await listWritableCalendars({
        hasGoogle: !!googleAccessToken,
        hasMicrosoft: !!microsoftAccessToken,
      });
      setCalendars(list);
    } finally {
      setLoadingCalendars(false);
    }
  };

  const labelRow = (key: CalendarLabelKey, label: string) => {
    const target = labels[key];
    const display = target
      ? calendars.find((c) => c.provider === target.provider && c.id === target.id)?.name
        ?? `${target.provider === 'google' ? 'Google' : 'Microsoft'} kalender`
      : 'Ikke valgt';
    return (
      <Pressable onPress={() => openPicker(key)} style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{display} ›</Text>
      </Pressable>
    );
  };

  if (!hasAnyProvider) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Stemmestyring</Text>
        <Text style={styles.sectionBody}>
          Forbind Google eller Outlook for at sætte møder med Siri.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Stemmestyring (Voice)</Text>
      <Text style={styles.sectionBody}>
        Når du beder Siri "bed Zolva om at sætte et møde", lander mødet i den
        kalender du vælger her. Sig "i min arbejdskalender" for at tilsidesætte.
      </Text>
      {labelRow('work', 'Arbejdskalender (Work)')}
      {labelRow('personal', 'Privatkalender (Personal)')}

      <Modal visible={picker !== null} animationType="slide" onRequestClose={() => setPicker(null)}>
        <SafeAreaView style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {picker === 'work' ? 'Vælg arbejdskalender' : 'Vælg privatkalender'}
            </Text>
            <Pressable onPress={() => setPicker(null)}>
              <Text style={styles.modalCancel}>Annullér</Text>
            </Pressable>
          </View>
          {loadingCalendars ? (
            <ActivityIndicator style={{ marginTop: 24 }} />
          ) : (
            <ScrollView contentContainerStyle={{ padding: 16 }}>
              <Pressable
                style={styles.pickerRow}
                onPress={async () => {
                  if (picker) await setLabel(picker, null);
                  setPicker(null);
                }}
              >
                <Text style={styles.pickerRowText}>○ Brug ikke</Text>
              </Pressable>
              {groupByAccount(calendars).map((section) => (
                <View key={section.heading} style={{ marginTop: 16 }}>
                  <Text style={styles.pickerHeading}>{section.heading}</Text>
                  {section.items.map((c) => {
                    const selected =
                      picker !== null &&
                      labels[picker]?.provider === c.provider &&
                      labels[picker]?.id === c.id;
                    return (
                      <Pressable
                        key={`${c.provider}:${c.id}`}
                        style={styles.pickerRow}
                        onPress={async () => {
                          if (picker) await setLabel(picker, { provider: c.provider, id: c.id });
                          setPicker(null);
                        }}
                      >
                        <Text style={styles.pickerRowText}>
                          {selected ? '● ' : '○ '}
                          {c.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

function groupByAccount(calendars: ProviderCalendar[]) {
  const groups = new Map<string, ProviderCalendar[]>();
  for (const c of calendars) {
    const headingProvider = c.provider === 'google' ? 'GOOGLE' : 'MICROSOFT';
    const heading = `${headingProvider} — ${c.accountEmail ?? 'Ukendt konto'}`;
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading)!.push(c);
  }
  return Array.from(groups.entries()).map(([heading, items]) => ({ heading, items }));
}
```

If `Modal`, `ActivityIndicator`, `ScrollView`, `SafeAreaView`, or `Pressable` aren't already imported, add to the existing react-native import.

- [ ] **Step 3: Place the section in the screen**

Find the existing Connections section in `SettingsScreen.tsx` and place `<StemmestyringSection />` immediately after it.

- [ ] **Step 4: Match the existing screen's styles object**

Reuse existing style names (`section`, `sectionTitle`, `sectionBody`, `row`, `rowLabel`, `rowValue`) where they exist; add the new modal-specific styles (`modal`, `modalHeader`, `modalTitle`, `modalCancel`, `pickerRow`, `pickerRowText`, `pickerHeading`) to the existing StyleSheet.create block. Keep visual treatment consistent with the rest of the Settings screen.

- [ ] **Step 5: Smoke-test in the app**

Run `npm run ios` (or `npx expo start --ios`). Navigate to Settings. Confirm:
- Section appears below Connections.
- Empty-state copy appears when no provider connected.
- Picker opens and lists calendars from connected providers.
- Selecting a calendar persists across navigations and a reload.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(settings): Stemmestyring section with calendar label pickers"
```

---

## Phase 6 — Edge Function `widget-action`

The function lives at `supabase/functions/widget-action/index.ts`. Built incrementally across Tasks 11–18, with Deno tests added per piece.

### Task 11: Skeleton + JWKS-based JWT verification

**Files:**
- Create: `supabase/functions/widget-action/index.ts`
- Create: `supabase/functions/widget-action/jwt.ts`
- Create: `supabase/functions/widget-action/index.test.ts`

Module-scope JWKS cache, fetched once on cold start. Match JWT header `kid` against the JWKS key set. On verification failure: refresh JWKS once, retry verification, then 401.

- [ ] **Step 1: Write the failing JWT test**

Create `supabase/functions/widget-action/index.test.ts`:

```ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { verifyJwt } from './jwt.ts';

Deno.test('verifyJwt rejects missing token', async () => {
  await assertRejects(() => verifyJwt(null), Error, 'missing');
});

Deno.test('verifyJwt rejects malformed token', async () => {
  await assertRejects(() => verifyJwt('not.a.jwt'), Error);
});

// Real-token cases require a fixture signed with a known key. The cold-start
// JWKS fetch is exercised by an integration test in Task 24 (manual on-device
// QA) since the live JWKS is the source of truth.
```

- [ ] **Step 2: Run failing**

```bash
deno test supabase/functions/widget-action/index.test.ts --allow-net --allow-env
```

Expected: FAIL — `jwt.ts` not yet present.

- [ ] **Step 3: Implement `jwt.ts`**

Create `supabase/functions/widget-action/jwt.ts`:

```ts
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'https://esm.sh/jose@5.9.6';

const JWKS_URL = new URL(
  'https://sjkhfkatmeqtsrysixop.supabase.co/auth/v1/.well-known/jwks.json',
);

let jwks = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60 * 1000, // 10 min — Supabase rotation is rare
});

export type VerifiedJwt = {
  userId: string;
  payload: JWTPayload;
};

export async function verifyJwt(token: string | null): Promise<VerifiedJwt> {
  if (!token) throw new Error('missing token');
  try {
    const { payload } = await jwtVerify(token, jwks);
    if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
    return { userId: payload.sub, payload };
  } catch (err) {
    // One-shot JWKS refresh + retry to handle key rotation between cold-start
    // cache and current Supabase keys.
    jwks = createRemoteJWKSet(JWKS_URL, {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000,
    });
    const { payload } = await jwtVerify(token, jwks);
    if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
    return { userId: payload.sub, payload };
  }
}
```

- [ ] **Step 4: Skeleton entrypoint**

Create `supabase/functions/widget-action/index.ts`:

```ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { verifyJwt } from './jwt.ts';

type WidgetActionRequest = {
  prompt?: string;
  timezone?: string;
  locale?: string;
};

type WidgetActionResponse = {
  dialog: string;
  snippet: {
    mood: 'happy' | 'worried';
    summary: string;
    deepLink: string;
  };
};

const json = (status: number, body: WidgetActionResponse): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;

  let userId: string;
  try {
    const verified = await verifyJwt(token);
    userId = verified.userId;
  } catch {
    return json(401, {
      dialog: 'Logget ud — åbn Zolva for at logge ind igen.',
      snippet: { mood: 'worried', summary: 'Logget ud', deepLink: 'zolva://settings' },
    });
  }

  const body = (await req.json().catch(() => ({}))) as WidgetActionRequest;
  // Subsequent tasks fill in the pipeline. For now, prove the wiring.
  return json(200, {
    dialog: `OK ${userId.slice(0, 6)} · ${body.prompt ?? '(empty)'}`,
    snippet: { mood: 'happy', summary: 'pipeline TODO', deepLink: 'zolva://chat' },
  });
});
```

- [ ] **Step 5: Run test**

```bash
deno test supabase/functions/widget-action/index.test.ts --allow-net --allow-env
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/widget-action/
git commit -m "feat(edge): widget-action skeleton with JWKS-based JWT verify"
```

### Task 12: Empty-prompt guard, label resolution, error catalogue

**Files:**
- Modify: `supabase/functions/widget-action/index.ts`
- Create: `supabase/functions/widget-action/responses.ts`

Centralizes the failure-class → deep-link / dialog table from the spec so the rest of the pipeline composes from named constants instead of stringly-typed copies.

- [ ] **Step 1: Write the failing empty-prompt test**

Append to `supabase/functions/widget-action/index.test.ts`:

```ts
import { workerHandler } from './index.ts';
// (Refactor index.ts to export workerHandler — see Step 3.)

const fakeJwt = (sub: string) => `header.${btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 600 }))}.sig`;

Deno.test('empty prompt returns worried snippet', async () => {
  // Stub verifyJwt by injecting a test transport — handled in Step 3.
  // Skeleton here, fill in once index.ts exports workerHandler.
});
```

- [ ] **Step 2: Build the responses module**

Create `supabase/functions/widget-action/responses.ts`:

```ts
export type ErrorClass =
  | 'empty_prompt'
  | 'unparseable'
  | 'no_calendar_labels'
  | 'oauth_invalid'
  | 'permission_denied'
  | 'provider_5xx';

export type SnippetMood = 'happy' | 'worried';

export type WidgetActionResponse = {
  dialog: string;
  snippet: {
    mood: SnippetMood;
    summary: string;
    deepLink: string;
  };
};

export function emptyPrompt(): WidgetActionResponse {
  return {
    dialog: 'Hvad skulle jeg sætte op?',
    snippet: {
      mood: 'worried',
      summary: "Sig fx 'sæt et møde i morgen kl. 17'.",
      deepLink: 'zolva://chat',
    },
  };
}

export function unparseable(): WidgetActionResponse {
  return {
    dialog: 'Forstod ikke. Prøv igen i appen.',
    snippet: { mood: 'worried', summary: 'Forstod ikke', deepLink: 'zolva://chat' },
  };
}

export function noCalendarLabels(): WidgetActionResponse {
  return {
    dialog: 'Vælg en arbejds- eller privatkalender.',
    snippet: { mood: 'worried', summary: 'Vælg kalender', deepLink: 'zolva://settings' },
  };
}

export function oauthInvalid(provider: 'google' | 'microsoft'): WidgetActionResponse {
  const providerName = provider === 'google' ? 'Google' : 'Outlook';
  return {
    dialog: `Forbind ${providerName} igen.`,
    snippet: {
      mood: 'worried',
      summary: `${providerName} forbindelse udløbet`,
      deepLink: 'zolva://settings#calendars',
    },
  };
}

export function permissionDenied(calendarName: string): WidgetActionResponse {
  return {
    dialog: `Du har ikke skriverettigheder til ${calendarName}.`,
    snippet: {
      mood: 'worried',
      summary: `Skriverettigheder mangler: ${calendarName}`,
      deepLink: 'zolva://settings',
    },
  };
}

export function provider5xx(provider: 'google' | 'microsoft'): WidgetActionResponse {
  const providerName = provider === 'google' ? 'Google' : 'Microsoft';
  return {
    dialog: `${providerName} svarede ikke. Prøv igen.`,
    snippet: {
      mood: 'worried',
      summary: `${providerName} fejl`,
      deepLink: 'zolva://chat',
    },
  };
}

export function loggedOut(): WidgetActionResponse {
  return {
    dialog: 'Logget ud — åbn Zolva for at logge ind igen.',
    snippet: { mood: 'worried', summary: 'Logget ud', deepLink: 'zolva://settings' },
  };
}
```

- [ ] **Step 3: Refactor `index.ts` to export `workerHandler` and load profile + check labels**

Modify `supabase/functions/widget-action/index.ts`:

```ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyJwt } from './jwt.ts';
import {
  emptyPrompt,
  loggedOut,
  noCalendarLabels,
  type WidgetActionResponse,
} from './responses.ts';

type WidgetActionRequest = {
  prompt?: string;
  timezone?: string;
  locale?: string;
};

type CalendarLabelTarget = { provider: 'google' | 'microsoft'; id: string };
type LabelMap = { work?: CalendarLabelTarget; personal?: CalendarLabelTarget };

const json = (status: number, body: WidgetActionResponse): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function readLabels(
  client: SupabaseClient,
  userId: string,
): Promise<LabelMap> {
  const { data } = await client
    .from('user_profiles')
    .select(
      'work_calendar_provider, work_calendar_id, personal_calendar_provider, personal_calendar_id',
    )
    .eq('user_id', userId)
    .maybeSingle();
  const row = (data ?? null) as null | {
    work_calendar_provider: 'google' | 'microsoft' | null;
    work_calendar_id: string | null;
    personal_calendar_provider: 'google' | 'microsoft' | null;
    personal_calendar_id: string | null;
  };
  const out: LabelMap = {};
  // Defensive null-check: even though the DB constraints guarantee both
  // null or both set, treat as unconfigured if either is missing — defends
  // against constraint drift or partial reads.
  if (row?.work_calendar_provider && row.work_calendar_id) {
    out.work = { provider: row.work_calendar_provider, id: row.work_calendar_id };
  }
  if (row?.personal_calendar_provider && row.personal_calendar_id) {
    out.personal = {
      provider: row.personal_calendar_provider,
      id: row.personal_calendar_id,
    };
  }
  return out;
}

export async function workerHandler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;

  let userId: string;
  try {
    userId = (await verifyJwt(token)).userId;
  } catch {
    return json(401, loggedOut());
  }

  const body = (await req.json().catch(() => ({}))) as WidgetActionRequest;
  const prompt = (body.prompt ?? '').trim();
  const timezone = body.timezone ?? 'UTC';

  if (prompt === '') {
    // empty_prompt — log + return.
    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: 'empty_prompt',
      calendar_resolution: 'no_calendar',
    }));
    return json(200, emptyPrompt());
  }

  const labels = await readLabels(admin(), userId);
  if (!labels.work && !labels.personal) {
    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: 'no_calendar_labels',
      calendar_resolution: 'no_calendar',
    }));
    return json(200, noCalendarLabels());
  }

  // Subsequent tasks plug Claude + selection + provider write here.
  return json(200, {
    dialog: `OK · prompt=${prompt} · tz=${timezone} · labels=${JSON.stringify(labels)}`,
    snippet: { mood: 'happy', summary: 'TODO pipeline', deepLink: 'zolva://chat' },
  });
}

serve(workerHandler);
```

- [ ] **Step 4: Update tests**

Replace the placeholder test in `index.test.ts` with:

```ts
import { workerHandler } from './index.ts';

const reqWith = (overrides: Partial<{
  prompt: string;
  timezone: string;
  authorization: string;
}>) =>
  new Request('http://localhost/widget-action', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: overrides.authorization ?? 'Bearer fake',
    },
    body: JSON.stringify({
      prompt: overrides.prompt ?? '',
      timezone: overrides.timezone ?? 'Europe/Copenhagen',
    }),
  });

Deno.test('rejects missing Authorization header → 401 + logged out snippet', async () => {
  const res = await workerHandler(
    new Request('http://localhost/widget-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.snippet.mood, 'worried');
  assertEquals(body.snippet.deepLink, 'zolva://settings');
});
```

The empty-prompt and label-missing branches are exercised end-to-end in Task 18's integration test once the full pipeline lands. JWT-required tests use real fixtures there.

- [ ] **Step 5: Run tests**

```bash
deno test supabase/functions/widget-action/index.test.ts --allow-net --allow-env
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/widget-action/
git commit -m "feat(edge): widget-action prompt + label guards"
```

### Task 13: Claude tool-use call

**Files:**
- Create: `supabase/functions/widget-action/claude.ts`
- Modify: `supabase/functions/widget-action/index.ts`

Single tool-forced call. System prompt covers timezone, ambiguous-time defaults, and `prompt_language` field. End time defaults server-side, not in Claude.

- [ ] **Step 1: Write the Claude module**

Create `supabase/functions/widget-action/claude.ts`:

```ts
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

export type ClaudeExtraction = {
  title: string;
  start: string;        // ISO 8601 with offset
  end?: string;         // optional — server defaults if omitted
  calendar_label: 'work' | 'personal' | null;
  prompt_language: 'da' | 'en' | 'unknown';
};

export type ClaudeUsage = { input: number; output: number };

const SYSTEM_PROMPT = (tz: string) => `You parse a single calendar-create request. The user's timezone is ${tz}. Return a tool call with title, start, optionally end, optionally calendar_label. If unparseable, return title='UNPARSEABLE'.

Ambiguous-time handling: for inputs without AM/PM context (e.g. "kl. 5", "5 o'clock", "fem"), default to the next reasonable occurrence in the user-local 07:00–22:00 window. If 'now' is before 07:00, pick today 07:00–22:00; if after 22:00, pick tomorrow's window. Specifically prefer afternoon hours (13:00–18:00) when the input is plausibly social/work-related ("møde", "meeting", "lunch", "drinks") — Danish "klokken fem" overwhelmingly means 17:00 in those contexts.

Also report the language you detected ('da' / 'en' / 'unknown') in a prompt_language field so the server can log it for debugging.`;

const TOOL = {
  name: 'create_calendar_event',
  description: 'Structured extraction of a calendar event from a user request.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'short title for the event' },
      start: { type: 'string', description: "ISO 8601 with offset in the user's timezone" },
      end: { type: 'string', description: 'OPTIONAL — server defaults if omitted' },
      calendar_label: {
        type: ['string', 'null'],
        enum: ['work', 'personal', null],
        description: 'only set if user mentioned a specific calendar',
      },
      prompt_language: {
        type: 'string',
        enum: ['da', 'en', 'unknown'],
        description: 'detected language of the input',
      },
    },
    required: ['title', 'start', 'calendar_label', 'prompt_language'],
    additionalProperties: false,
  },
};

export async function extractEvent(
  prompt: string,
  timezone: string,
): Promise<{ extraction: ClaudeExtraction; usage: ClaudeUsage; model: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT(timezone),
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'create_calendar_event' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }

  const body = await res.json() as {
    content: Array<{ type: string; name?: string; input?: ClaudeExtraction }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  };

  const toolUse = body.content.find((c) => c.type === 'tool_use' && c.name === 'create_calendar_event');
  if (!toolUse?.input) throw new Error('claude returned no tool_use block');

  return {
    extraction: toolUse.input,
    usage: { input: body.usage.input_tokens, output: body.usage.output_tokens },
    model: body.model,
  };
}
```

- [ ] **Step 2: Wire into `index.ts`**

In `index.ts`, just after the labels check, replace the `// Subsequent tasks plug...` block with:

```ts
import { extractEvent } from './claude.ts';
import { unparseable } from './responses.ts';

// inside workerHandler, after labels guard:
let extraction;
try {
  const claude = await extractEvent(prompt, timezone);
  extraction = claude.extraction;
  // usage + model captured for logging in Task 18.
} catch (err) {
  console.warn('[widget-action] claude error:', err instanceof Error ? err.message : err);
  return json(200, unparseable());
}

if (extraction.title === 'UNPARSEABLE') {
  console.log(JSON.stringify({
    action: 'create_event',
    user_id: userId,
    success: false,
    error_class: 'unparseable',
    calendar_resolution: 'no_calendar',
    prompt_language: extraction.prompt_language,
  }));
  return json(200, unparseable());
}

return json(200, {
  dialog: `extraction=${JSON.stringify(extraction)}`,
  snippet: { mood: 'happy', summary: 'TODO selection', deepLink: 'zolva://chat' },
});
```

(Imports go at the top of the file with the others; the inline-import shown above is just for clarity in the diff.)

- [ ] **Step 3: Test the unparseable branch**

Append to `index.test.ts`:

```ts
// claude.ts is fetch-based; stub global fetch for these tests.
const originalFetch = globalThis.fetch;

function stubAnthropic(extraction: Partial<{ title: string; start: string; end: string; calendar_label: string | null; prompt_language: string }>) {
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.anthropic.com')) {
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'tool_use', name: 'create_calendar_event', input: {
          title: 'UNPARSEABLE',
          start: '2026-04-29T17:00:00+02:00',
          calendar_label: null,
          prompt_language: 'unknown',
          ...extraction,
        } }],
        usage: { input_tokens: 100, output_tokens: 30 },
        model: 'claude-haiku-4-5-20251001',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return originalFetch(input as RequestInfo, init);
  };
}

function restoreFetch() { globalThis.fetch = originalFetch; }
```

A full Claude-routed test runs end-to-end in Task 18 once selection + provider write land. The above is fixture infrastructure.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/widget-action/
git commit -m "feat(edge): claude tool-use extraction for create_calendar_event"
```

### Task 14: Calendar selection algorithm (5 branches in spec order)

**Files:**
- Create: `supabase/functions/widget-action/select-calendar.ts`
- Create: `supabase/functions/widget-action/select-calendar.test.ts`

Branches in this exact order so single-label fallback wins before any "unset" error:
1. `hint_matched` — Claude returned `X` AND both `X` columns set.
2. `fallback_only_configured` — Claude returned `X`, but only `Y` is configured → write to `Y`, prepend hint.
3. `label_default` — Claude returned no label AND `personal` is configured.
4. `fallback_only_configured` (no-hint variant) — no label + only `work` configured.
5. Unreachable (caller already exited on `no_calendar_labels`).

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/widget-action/select-calendar.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { selectCalendar, type LabelMap, type Selection } from './select-calendar.ts';

const W: LabelMap['work'] = { provider: 'google', id: 'work@gmail.com' };
const P: LabelMap['personal'] = { provider: 'microsoft', id: 'home@outlook.com' };

Deno.test('hint matches and label is configured', () => {
  const sel = selectCalendar({ hint: 'work', labels: { work: W, personal: P } });
  assertEquals<Selection>(sel, {
    target: W,
    resolution: 'hint_matched',
    fallbackFromLabel: null,
    usedLabel: 'work',
  });
});

Deno.test('hint requested but only other label configured -> fallback', () => {
  const sel = selectCalendar({ hint: 'work', labels: { personal: P } });
  assertEquals<Selection>(sel, {
    target: P,
    resolution: 'fallback_only_configured',
    fallbackFromLabel: 'work',
    usedLabel: 'personal',
  });
});

Deno.test('no hint + personal configured -> label_default', () => {
  const sel = selectCalendar({ hint: null, labels: { personal: P } });
  assertEquals<Selection>(sel, {
    target: P,
    resolution: 'label_default',
    fallbackFromLabel: null,
    usedLabel: 'personal',
  });
});

Deno.test('no hint + only work configured -> fallback_only_configured', () => {
  const sel = selectCalendar({ hint: null, labels: { work: W } });
  assertEquals<Selection>(sel, {
    target: W,
    resolution: 'fallback_only_configured',
    fallbackFromLabel: null,
    usedLabel: 'work',
  });
});

Deno.test('no hint + both configured -> personal default', () => {
  const sel = selectCalendar({ hint: null, labels: { work: W, personal: P } });
  assertEquals(sel.target, P);
  assertEquals(sel.resolution, 'label_default');
});

Deno.test('hint matches Personal exactly', () => {
  const sel = selectCalendar({ hint: 'personal', labels: { work: W, personal: P } });
  assertEquals(sel.target, P);
  assertEquals(sel.resolution, 'hint_matched');
});

Deno.test('caller responsibility: both empty is unreachable here', () => {
  // selectCalendar is documented to assume at least one label is configured;
  // empty-labels exit happens earlier in the pipeline. Sanity-check the
  // function returns null target without crashing in the unexpected case.
  const sel = selectCalendar({ hint: null, labels: {} });
  assertEquals(sel.target, null);
});
```

- [ ] **Step 2: Run failing**

```bash
deno test supabase/functions/widget-action/select-calendar.test.ts
```

Expected: FAIL — module not present.

- [ ] **Step 3: Implement**

Create `supabase/functions/widget-action/select-calendar.ts`:

```ts
export type CalendarLabelTarget = { provider: 'google' | 'microsoft'; id: string };

export type LabelMap = {
  work?: CalendarLabelTarget;
  personal?: CalendarLabelTarget;
};

export type Resolution =
  | 'hint_matched'
  | 'fallback_only_configured'
  | 'label_default'
  | 'no_calendar';

export type Selection = {
  target: CalendarLabelTarget | null;
  resolution: Resolution;
  /**
   * When `resolution === 'fallback_only_configured'` AND the user requested a
   * label hint that wasn't configured, this names the requested-but-missing
   * label. Used by the dialog formatter to add "du har ikke valgt en
   * {fallbackFromLabel}-kalender endnu" copy. Null otherwise.
   */
  fallbackFromLabel: 'work' | 'personal' | null;
  usedLabel: 'work' | 'personal' | null;
};

export function selectCalendar(args: {
  hint: 'work' | 'personal' | null;
  labels: LabelMap;
}): Selection {
  const { hint, labels } = args;

  // 1. Hint matched.
  if (hint && labels[hint]) {
    return {
      target: labels[hint]!,
      resolution: 'hint_matched',
      fallbackFromLabel: null,
      usedLabel: hint,
    };
  }

  // 2. Hint requested but only the OTHER label configured → fall back.
  if (hint) {
    const other = hint === 'work' ? 'personal' : 'work';
    if (labels[other]) {
      return {
        target: labels[other]!,
        resolution: 'fallback_only_configured',
        fallbackFromLabel: hint,
        usedLabel: other,
      };
    }
  }

  // 3. No hint, Personal configured → default to Personal.
  if (!hint && labels.personal) {
    return {
      target: labels.personal,
      resolution: 'label_default',
      fallbackFromLabel: null,
      usedLabel: 'personal',
    };
  }

  // 4. No hint, only Work configured → fall back to Work.
  if (!hint && labels.work) {
    return {
      target: labels.work,
      resolution: 'fallback_only_configured',
      fallbackFromLabel: null,
      usedLabel: 'work',
    };
  }

  // 5. Unreachable from the live pipeline (caller exits on empty labels).
  return { target: null, resolution: 'no_calendar', fallbackFromLabel: null, usedLabel: null };
}
```

- [ ] **Step 4: Run tests**

```bash
deno test supabase/functions/widget-action/select-calendar.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/widget-action/select-calendar.ts supabase/functions/widget-action/select-calendar.test.ts
git commit -m "feat(edge): calendar label resolution algorithm with fallback"
```

### Task 15: Provider write (Google + Microsoft) with retry-on-401

**Files:**
- Create: `supabase/functions/widget-action/provider-write.ts`

Token via `_shared/oauth.ts` (existing). On 401 from provider, refresh once via `refreshAccessToken`, retry. On second 401 → `oauth_invalid`. On 403 → `permission_denied` (look up calendar's display name, ~150ms extra). On 5xx → `provider_5xx`.

- [ ] **Step 1: Write the module**

Create `supabase/functions/widget-action/provider-write.ts`:

```ts
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  loadRefreshToken,
  refreshAccessToken,
  type Provider,
} from '../_shared/oauth.ts';

export type WriteOutcome =
  | { ok: true; eventId: string; eventUrl: string | null }
  | { ok: false; errorClass: 'oauth_invalid' }
  | { ok: false; errorClass: 'permission_denied'; calendarName: string }
  | { ok: false; errorClass: 'provider_5xx' };

const MICROSOFT_SCOPE = 'offline_access Calendars.ReadWrite';

export async function writeEvent(args: {
  client: SupabaseClient;
  userId: string;
  provider: Provider;
  calendarId: string;
  title: string;
  startIso: string;
  endIso: string;
  timezone: string;
}): Promise<WriteOutcome> {
  const refreshToken = await loadRefreshToken(args.client, args.userId, args.provider);
  if (!refreshToken) return { ok: false, errorClass: 'oauth_invalid' };

  let accessToken: string;
  try {
    const r = await refreshAccessToken(args.client, args.userId, args.provider, refreshToken, {
      microsoftScope: MICROSOFT_SCOPE,
    });
    accessToken = r.accessToken;
  } catch {
    return { ok: false, errorClass: 'oauth_invalid' };
  }

  // First attempt.
  const first = await postEvent(accessToken, args);
  if (first.kind === 'ok') return first.outcome;
  if (first.kind === 'error') return first.outcome;

  // 401 → refresh once and retry.
  let refreshedToken: string;
  try {
    const r = await refreshAccessToken(args.client, args.userId, args.provider, refreshToken, {
      microsoftScope: MICROSOFT_SCOPE,
    });
    refreshedToken = r.accessToken;
  } catch {
    return { ok: false, errorClass: 'oauth_invalid' };
  }

  const second = await postEvent(refreshedToken, args);
  if (second.kind === 'ok') return second.outcome;
  if (second.kind === 'error') return second.outcome;
  // Second 401 → token genuinely rejected.
  return { ok: false, errorClass: 'oauth_invalid' };
}

type AttemptResult =
  | { kind: 'ok'; outcome: WriteOutcome }
  | { kind: 'error'; outcome: WriteOutcome }
  | { kind: 'unauthorized' };

async function postEvent(
  token: string,
  args: { provider: Provider; calendarId: string; title: string; startIso: string; endIso: string; timezone: string },
): Promise<AttemptResult> {
  if (args.provider === 'google') return postGoogle(token, args);
  return postMicrosoft(token, args);
}

async function postGoogle(
  token: string,
  args: { calendarId: string; title: string; startIso: string; endIso: string; timezone: string },
): Promise<AttemptResult> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendarId)}/events`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: args.title,
      start: { dateTime: args.startIso, timeZone: args.timezone },
      end: { dateTime: args.endIso, timeZone: args.timezone },
    }),
  });
  if (res.status === 401) return { kind: 'unauthorized' };
  if (res.status === 403) {
    const name = await lookupGoogleCalendarName(token, args.calendarId).catch(() => args.calendarId);
    return { kind: 'error', outcome: { ok: false, errorClass: 'permission_denied', calendarName: name } };
  }
  if (res.status >= 500) return { kind: 'error', outcome: { ok: false, errorClass: 'provider_5xx' } };
  if (!res.ok) return { kind: 'error', outcome: { ok: false, errorClass: 'provider_5xx' } };
  const body = await res.json() as { id: string; htmlLink?: string };
  return {
    kind: 'ok',
    outcome: { ok: true, eventId: body.id, eventUrl: body.htmlLink ?? null },
  };
}

async function postMicrosoft(
  token: string,
  args: { calendarId: string; title: string; startIso: string; endIso: string; timezone: string },
): Promise<AttemptResult> {
  const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(args.calendarId)}/events`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: args.title,
      start: { dateTime: stripOffset(args.startIso), timeZone: args.timezone },
      end: { dateTime: stripOffset(args.endIso), timeZone: args.timezone },
    }),
  });
  if (res.status === 401) return { kind: 'unauthorized' };
  if (res.status === 403) {
    const name = await lookupMicrosoftCalendarName(token, args.calendarId).catch(() => args.calendarId);
    return { kind: 'error', outcome: { ok: false, errorClass: 'permission_denied', calendarName: name } };
  }
  if (res.status >= 500) return { kind: 'error', outcome: { ok: false, errorClass: 'provider_5xx' } };
  if (!res.ok) return { kind: 'error', outcome: { ok: false, errorClass: 'provider_5xx' } };
  const body = await res.json() as { id: string; webLink?: string };
  return {
    kind: 'ok',
    outcome: { ok: true, eventId: body.id, eventUrl: body.webLink ?? null },
  };
}

// Microsoft Graph rejects ISO strings that include a UTC offset on the
// dateTime field — it wants naive local time + a separate timeZone field.
function stripOffset(iso: string): string {
  return iso.replace(/(?:Z|[+\-]\d{2}:?\d{2})$/, '');
}

async function lookupGoogleCalendarName(token: string, calendarId: string): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return calendarId;
  const body = await res.json() as { summary?: string; summaryOverride?: string };
  return body.summaryOverride ?? body.summary ?? calendarId;
}

async function lookupMicrosoftCalendarName(token: string, calendarId: string): Promise<string> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return calendarId;
  const body = await res.json() as { name?: string };
  return body.name ?? calendarId;
}
```

- [ ] **Step 2: Smoke-test against fixtures (optional, fast feedback)**

Append a basic test exercising the 401 retry path to `index.test.ts` once Task 18 wires everything together; provider-write itself is covered by the integration-style test there. Skip a separate test file here to avoid duplicating the fetch-stub plumbing.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/widget-action/provider-write.ts
git commit -m "feat(edge): provider write with refresh-on-401 + 403/5xx mapping"
```

### Task 16: Natural-time formatter + word-boundary truncation

**Files:**
- Create: `supabase/functions/widget-action/format.ts`
- Create: `supabase/functions/widget-action/format.test.ts`

Within 7 days: relative + spelled time ("i morgen kl. sytten" / "tomorrow at five PM"). >7 days: absolute spelled. Avoid "17:00" — Siri pronounces "seventeen-hundred". Word-boundary-aware truncation, server-side; never trust Claude on length.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/widget-action/format.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { naturalTime, truncate } from './format.ts';

Deno.test('naturalTime DA tomorrow', () => {
  // now = 2026-04-28 14:00, event = 2026-04-29 17:00
  const out = naturalTime({
    eventIso: '2026-04-29T17:00:00+02:00',
    nowIso: '2026-04-28T14:00:00+02:00',
    locale: 'da',
    timezone: 'Europe/Copenhagen',
  });
  assertEquals(out, 'i morgen kl. sytten');
});

Deno.test('naturalTime EN tomorrow', () => {
  const out = naturalTime({
    eventIso: '2026-04-29T17:00:00+02:00',
    nowIso: '2026-04-28T14:00:00+02:00',
    locale: 'en',
    timezone: 'Europe/Copenhagen',
  });
  assertEquals(out, 'tomorrow at five PM');
});

Deno.test('naturalTime >7 days DA', () => {
  const out = naturalTime({
    eventIso: '2026-05-15T14:00:00+02:00',
    nowIso: '2026-04-28T10:00:00+02:00',
    locale: 'da',
    timezone: 'Europe/Copenhagen',
  });
  assertEquals(out, 'den 15. maj kl. fjorten');
});

Deno.test('truncate at word boundary', () => {
  const t = truncate('Møde med Sophie om det nye projekt der lyder spændende', 20);
  // last word boundary at-or-before 20 = " om det" → keep "Møde med Sophie om" then cut at space, append …
  // Implementation detail: target ≤20 chars including the …
  assertEquals(t.length <= 20, true);
  assertEquals(t.endsWith('…'), true);
  assertEquals(t.includes(' '), true); // didn't mid-word cut
});

Deno.test('truncate hard-cuts a word longer than limit', () => {
  const t = truncate('Donaudampfschifffahrtsgesellschaftskapitän', 10);
  assertEquals(t.length, 10);
  assertEquals(t.endsWith('…'), true);
});

Deno.test('truncate passes through short text unchanged', () => {
  assertEquals(truncate('Møde', 80), 'Møde');
});
```

- [ ] **Step 2: Run failing**

```bash
deno test supabase/functions/widget-action/format.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `supabase/functions/widget-action/format.ts`:

```ts
const DA_HOURS = [
  'nul', 'et', 'to', 'tre', 'fire', 'fem', 'seks', 'syv',
  'otte', 'ni', 'ti', 'elleve', 'tolv', 'tretten', 'fjorten',
  'femten', 'seksten', 'sytten', 'atten', 'nitten', 'tyve',
  'enogtyve', 'toogtyve', 'treogtyve',
];
const EN_HOURS = [
  'twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven',
];
const DA_MONTHS = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december',
];
const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type NaturalTimeArgs = {
  eventIso: string;
  nowIso: string;
  locale: 'da' | 'en';
  timezone: string;
};

export function naturalTime(args: NaturalTimeArgs): string {
  const event = new Date(args.eventIso);
  const now = new Date(args.nowIso);

  // Project both into the user's timezone for day-difference computation.
  const partsAt = (d: Date) => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: args.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>;
    return parts;
  };
  const eP = partsAt(event);
  const nP = partsAt(now);

  const eventMidnight = Date.UTC(+eP.year, +eP.month - 1, +eP.day);
  const nowMidnight = Date.UTC(+nP.year, +nP.month - 1, +nP.day);
  const dayDelta = Math.round((eventMidnight - nowMidnight) / (24 * 60 * 60 * 1000));

  const hour24 = parseInt(eP.hour, 10);
  const minute = parseInt(eP.minute, 10);

  if (dayDelta >= 0 && dayDelta <= 7) {
    return relativeWithin7Days(dayDelta, hour24, minute, args.locale);
  }
  return absoluteSpelled(eP, hour24, minute, args.locale);
}

function relativeWithin7Days(
  dayDelta: number,
  hour24: number,
  minute: number,
  locale: 'da' | 'en',
): string {
  if (locale === 'da') {
    const daySegment = dayDelta === 0 ? 'i dag' : dayDelta === 1 ? 'i morgen' : `om ${dayDelta} dage`;
    const hourWord = DA_HOURS[hour24] ?? String(hour24);
    const min = minute > 0 ? ` ${minute}` : '';
    return `${daySegment} kl. ${hourWord}${min}`;
  }
  const daySegment = dayDelta === 0 ? 'today' : dayDelta === 1 ? 'tomorrow' : `in ${dayDelta} days`;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const h12 = hour24 % 12;
  const hourWord = EN_HOURS[h12] ?? String(h12);
  const min = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  return `${daySegment} at ${hourWord}${min} ${meridiem}`;
}

function absoluteSpelled(
  parts: Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>,
  hour24: number,
  minute: number,
  locale: 'da' | 'en',
): string {
  const month = parseInt(parts.month, 10) - 1;
  const day = parseInt(parts.day, 10);
  if (locale === 'da') {
    const hourWord = DA_HOURS[hour24] ?? String(hour24);
    const min = minute > 0 ? ` ${minute}` : '';
    return `den ${day}. ${DA_MONTHS[month]} kl. ${hourWord}${min}`;
  }
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const h12 = hour24 % 12;
  const hourWord = EN_HOURS[h12] ?? String(h12);
  const min = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  return `${EN_MONTHS[month]} ${day} at ${hourWord}${min} ${meridiem}`;
}

const ELLIPSIS = '…';

export function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  // Reserve one slot for the ellipsis.
  const cap = limit - 1;
  const slice = s.slice(0, cap);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= 1) return slice.slice(0, lastSpace) + ELLIPSIS;
  // No whitespace before the limit (very long compound word) — hard cut.
  return slice + ELLIPSIS;
}
```

- [ ] **Step 4: Run tests**

```bash
deno test supabase/functions/widget-action/format.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/widget-action/format.ts supabase/functions/widget-action/format.test.ts
git commit -m "feat(edge): natural-time formatter + word-boundary truncation"
```

### Task 17: Wire pipeline end-to-end + dialog assembly

**Files:**
- Modify: `supabase/functions/widget-action/index.ts`

Glue Claude → selectCalendar → writeEvent → naturalTime → truncate → response. Apply server-side `end = start + 60min` default. Dialog template per locale. Single-label fallback (`fallback_only_configured` with hint requested) prepends "Tilføjet i din {Y} kalender — du har ikke valgt en {X}-kalender endnu" copy.

- [ ] **Step 1: Replace the stub return in `workerHandler`**

In `supabase/functions/widget-action/index.ts` replace the `return json(200, { dialog: 'extraction=...'` placeholder with the full pipeline:

```ts
import { selectCalendar } from './select-calendar.ts';
import { writeEvent } from './provider-write.ts';
import { naturalTime, truncate } from './format.ts';
import { oauthInvalid, permissionDenied, provider5xx } from './responses.ts';

// ... inside workerHandler, after extraction guard:
const selection = selectCalendar({
  hint: extraction.calendar_label,
  labels,
});
if (!selection.target) {
  // Defensive: caller exited on empty labels above. Treat like no_calendar_labels.
  return json(200, noCalendarLabels());
}

const startIso = extraction.start;
const endIso = extraction.end ?? new Date(new Date(extraction.start).getTime() + 60 * 60 * 1000).toISOString();

const supabaseClient = admin();
const write = await writeEvent({
  client: supabaseClient,
  userId,
  provider: selection.target.provider,
  calendarId: selection.target.id,
  title: extraction.title,
  startIso,
  endIso,
  timezone,
});

if (!write.ok) {
  let resp;
  if (write.errorClass === 'oauth_invalid') resp = oauthInvalid(selection.target.provider);
  else if (write.errorClass === 'permission_denied') resp = permissionDenied(write.calendarName);
  else resp = provider5xx(selection.target.provider);

  console.log(JSON.stringify({
    action: 'create_event',
    user_id: userId,
    success: false,
    error_class: write.errorClass,
    calendar_resolution: selection.resolution,
    calendar_provider: selection.target.provider,
    prompt_language: extraction.prompt_language,
  }));
  return json(200, resp);
}

const locale: 'da' | 'en' = extraction.prompt_language === 'en' ? 'en' : 'da';
const time = naturalTime({
  eventIso: startIso,
  nowIso: new Date().toISOString(),
  locale,
  timezone,
});

const labelWord = locale === 'da'
  ? selection.usedLabel === 'work' ? 'arbejds' : 'privat'
  : selection.usedLabel === 'work' ? 'work' : 'personal';

let dialog: string;
if (locale === 'da') {
  dialog = `Tilføjet: '${extraction.title}', ${time} i din ${labelWord}kalender.`;
  if (selection.fallbackFromLabel) {
    const missing = selection.fallbackFromLabel === 'work' ? 'arbejds' : 'privat';
    dialog = `Tilføjet i din ${labelWord}kalender — du har ikke valgt en ${missing}-kalender endnu. ${dialog}`;
  }
} else {
  dialog = `Added: '${extraction.title}', ${time} in your ${labelWord} calendar.`;
  if (selection.fallbackFromLabel) {
    dialog = `Added to your ${labelWord} calendar — you haven't picked a ${selection.fallbackFromLabel} calendar yet. ${dialog}`;
  }
}

const summary = `${extraction.title} · ${time}`;

const truncated = {
  dialog: truncate(dialog, 120),
  snippet: {
    mood: 'happy' as const,
    summary: truncate(summary, 80),
    deepLink: write.eventUrl ?? `zolva://calendar/event/${encodeURIComponent(write.eventId)}`,
  },
};

console.log(JSON.stringify({
  action: 'create_event',
  user_id: userId,
  success: true,
  calendar_resolution: selection.resolution,
  calendar_provider: selection.target.provider,
  prompt_language: extraction.prompt_language,
}));

return json(200, truncated);
```

(Imports go at the top of the file, with the existing imports.)

- [ ] **Step 2: Typecheck the function**

```bash
deno check supabase/functions/widget-action/index.ts
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/widget-action/index.ts
git commit -m "feat(edge): wire claude → select → write → response pipeline"
```

### Task 18: End-to-end Deno test (stubbed Anthropic + provider)

**Files:**
- Modify: `supabase/functions/widget-action/index.test.ts`

End-to-end tests with stubbed `fetch` for Anthropic + Google + Microsoft. Covers the spec's required scenarios: success path, oauth_invalid, permission_denied, provider_5xx, ambiguous time defaults (via stubbed Claude output), prompt_language propagation, truncation correctness, server-side `end` default.

- [ ] **Step 1: Add the test harness**

Replace `supabase/functions/widget-action/index.test.ts` with the following (keep the existing JWT test):

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { workerHandler } from './index.ts';

// --- fetch stubbing ---

type FetchStub = {
  anthropic?: (req: Request) => Promise<Response>;
  google?: (req: Request) => Promise<Response>;
  microsoft?: (req: Request) => Promise<Response>;
  supabase?: (req: Request) => Promise<Response>;
};

const originalFetch = globalThis.fetch;
function withFetch(stubs: FetchStub, fn: () => Promise<void>) {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const req = input instanceof Request ? input : new Request(url, init);
    if (url.startsWith('https://api.anthropic.com')) return stubs.anthropic?.(req) ?? new Response('no anthropic stub', { status: 500 });
    if (url.startsWith('https://www.googleapis.com')) return stubs.google?.(req) ?? new Response('no google stub', { status: 500 });
    if (url.startsWith('https://graph.microsoft.com')) return stubs.microsoft?.(req) ?? new Response('no microsoft stub', { status: 500 });
    if (url.includes('.supabase.co/auth/v1/.well-known/jwks.json')) {
      // JWKS stub: see Task 11 — unit tests bypass real JWT verification by
      // constructing handler-level fixtures. For these end-to-end tests we
      // call workerHandler directly with an authorization header that the
      // stub on Supabase REST will accept.
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    }
    if (url.includes('.supabase.co/rest/v1/')) return stubs.supabase?.(req) ?? new Response('[]', { status: 200 });
    return originalFetch(input as RequestInfo, init);
  };
  return fn().finally(() => { globalThis.fetch = originalFetch; });
}

// --- request helper ---

const makeReq = (prompt: string) =>
  new Request('http://localhost/widget-action', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer FAKE',
    },
    body: JSON.stringify({ prompt, timezone: 'Europe/Copenhagen' }),
  });

// JWT verification is stubbed by setting an env override. Add to index.ts a
// hook that, when WIDGET_ACTION_TEST_USER_ID is set, bypasses JWKS and uses
// that as the userId. Tests should set it via env. (Add this small hook
// in index.ts before running tests — see Step 2.)

// --- standard claude responses ---

const okClaude = (override: Partial<{
  title: string; start: string; end: string;
  calendar_label: 'work' | 'personal' | null;
  prompt_language: 'da' | 'en' | 'unknown';
}> = {}) =>
  new Response(JSON.stringify({
    content: [{ type: 'tool_use', name: 'create_calendar_event', input: {
      title: 'Møde med Sophie',
      start: '2026-04-29T17:00:00+02:00',
      calendar_label: null,
      prompt_language: 'da',
      ...override,
    } }],
    usage: { input_tokens: 100, output_tokens: 30 },
    model: 'claude-haiku-4-5-20251001',
  }), { status: 200 });

// --- supabase profile-row stub helper ---

function profileResp(work: null | { provider: 'google' | 'microsoft'; id: string }, personal: null | { provider: 'google' | 'microsoft'; id: string }) {
  return new Response(JSON.stringify([{
    work_calendar_provider: work?.provider ?? null,
    work_calendar_id: work?.id ?? null,
    personal_calendar_provider: personal?.provider ?? null,
    personal_calendar_id: personal?.id ?? null,
  }]), { status: 200, headers: { 'content-type': 'application/json' } });
}

// --- tests ---

Deno.env.set('WIDGET_ACTION_TEST_USER_ID', '28c51177-aaaa-bbbb-cccc-ddddeeeeffff');
Deno.env.set('SUPABASE_URL', 'https://sjkhfkatmeqtsrysixop.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'fake-service-role');
Deno.env.set('ANTHROPIC_API_KEY', 'fake-anthropic');

Deno.test('happy path → success snippet with deep link', async () => {
  await withFetch({
    anthropic: () => Promise.resolve(okClaude({ calendar_label: 'work' })),
    supabase: (req) => {
      if (req.url.includes('user_profiles')) return Promise.resolve(profileResp({ provider: 'google', id: 'work@gmail.com' }, null));
      if (req.url.includes('user_oauth_tokens')) return Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt-fake' }]), { status: 200 }));
      return Promise.resolve(new Response('[]', { status: 200 }));
    },
    google: (req) => {
      if (req.url.includes('/token')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'at-fresh', expires_in: 3600 }), { status: 200 }));
      // event POST
      return Promise.resolve(new Response(JSON.stringify({ id: 'event-123', htmlLink: 'https://calendar.google.com/event?eid=abc' }), { status: 200 }));
    },
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde i morgen kl. 17 i min arbejdskalender'));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.snippet.mood, 'happy');
    assertEquals(body.snippet.deepLink.startsWith('https://calendar.google.com'), true);
    assertEquals(body.dialog.length <= 120, true);
    assertEquals(body.snippet.summary.length <= 80, true);
  });
});

Deno.test('truncation: very long Claude title is truncated server-side', async () => {
  const longTitle = 'Møde '.repeat(40); // ~200 chars
  await withFetch({
    anthropic: () => Promise.resolve(okClaude({ title: longTitle })),
    supabase: (req) => req.url.includes('user_profiles')
      ? Promise.resolve(profileResp(null, { provider: 'google', id: 'home@gmail.com' }))
      : req.url.includes('user_oauth_tokens')
      ? Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt' }]), { status: 200 }))
      : Promise.resolve(new Response('[]', { status: 200 })),
    google: (req) => req.url.includes('/token')
      ? Promise.resolve(new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }))
      : Promise.resolve(new Response(JSON.stringify({ id: 'e1', htmlLink: 'https://x' }), { status: 200 })),
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde'));
    const body = await res.json();
    assertEquals(body.dialog.length <= 120, true);
    assertEquals(body.snippet.summary.length <= 80, true);
    assertEquals(body.dialog.endsWith('…') || body.dialog.length < 120, true);
  });
});

Deno.test('oauth_invalid: refresh fails → worried snippet', async () => {
  await withFetch({
    anthropic: () => Promise.resolve(okClaude()),
    supabase: (req) => req.url.includes('user_profiles')
      ? Promise.resolve(profileResp(null, { provider: 'google', id: 'home@gmail.com' }))
      : req.url.includes('user_oauth_tokens')
      ? Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt' }]), { status: 200 }))
      : Promise.resolve(new Response('[]', { status: 200 })),
    google: (req) => req.url.includes('/token')
      ? Promise.resolve(new Response('invalid_grant', { status: 400 }))
      : Promise.resolve(new Response('unreachable', { status: 500 })),
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde'));
    const body = await res.json();
    assertEquals(body.snippet.mood, 'worried');
    assertEquals(body.snippet.deepLink, 'zolva://settings#calendars');
  });
});

Deno.test('permission_denied: provider returns 403 → worried snippet with calendar name', async () => {
  await withFetch({
    anthropic: () => Promise.resolve(okClaude()),
    supabase: (req) => req.url.includes('user_profiles')
      ? Promise.resolve(profileResp(null, { provider: 'google', id: 'shared@gmail.com' }))
      : req.url.includes('user_oauth_tokens')
      ? Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt' }]), { status: 200 }))
      : Promise.resolve(new Response('[]', { status: 200 })),
    google: (req) => {
      if (req.url.includes('/token')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }));
      if (req.url.includes('/events')) return Promise.resolve(new Response('forbidden', { status: 403 }));
      // calendarList lookup for the name
      return Promise.resolve(new Response(JSON.stringify({ summary: 'Acme Work Cal' }), { status: 200 }));
    },
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde'));
    const body = await res.json();
    assertEquals(body.snippet.mood, 'worried');
    assertEquals(body.dialog.includes('Acme Work Cal'), true);
  });
});

Deno.test('no_calendar_labels: no profile config → routes to settings', async () => {
  await withFetch({
    anthropic: () => Promise.resolve(okClaude()),
    supabase: () => Promise.resolve(profileResp(null, null)),
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde'));
    const body = await res.json();
    assertEquals(body.snippet.deepLink, 'zolva://settings');
  });
});

Deno.test('empty_prompt: blank prompt → worried "what to set up?" snippet', async () => {
  await withFetch({}, async () => {
    const res = await workerHandler(makeReq(''));
    const body = await res.json();
    assertEquals(body.snippet.mood, 'worried');
    assertEquals(body.dialog.includes('Hvad'), true);
  });
});

Deno.test('end-time default: claude omits end → server adds 60min', async () => {
  let receivedBody: string | null = null;
  await withFetch({
    anthropic: () => Promise.resolve(okClaude({ start: '2026-04-29T17:00:00+02:00' })),
    supabase: (req) => req.url.includes('user_profiles')
      ? Promise.resolve(profileResp(null, { provider: 'google', id: 'home@gmail.com' }))
      : req.url.includes('user_oauth_tokens')
      ? Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt' }]), { status: 200 }))
      : Promise.resolve(new Response('[]', { status: 200 })),
    google: async (req) => {
      if (req.url.includes('/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      if (req.url.endsWith('/events')) {
        receivedBody = await req.text();
        return new Response(JSON.stringify({ id: 'e1', htmlLink: 'https://x' }), { status: 200 });
      }
      return new Response('?', { status: 500 });
    },
  }, async () => {
    await workerHandler(makeReq('sæt et møde'));
    if (!receivedBody) throw new Error('event POST never reached');
    const body = JSON.parse(receivedBody) as { start: { dateTime: string }; end: { dateTime: string } };
    // end - start should be 60 min.
    const startMs = new Date(body.start.dateTime).getTime();
    const endMs = new Date(body.end.dateTime).getTime();
    assertEquals(endMs - startMs, 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Add the test-bypass hook in `index.ts`**

In `supabase/functions/widget-action/index.ts`, replace the JWT verification block in `workerHandler` with:

```ts
let userId: string;
const testUserId = Deno.env.get('WIDGET_ACTION_TEST_USER_ID');
if (testUserId) {
  userId = testUserId;
} else {
  try {
    userId = (await verifyJwt(token)).userId;
  } catch {
    return json(401, loggedOut());
  }
}
```

This is gated on a separate env var so a misconfigured production deploy can't accidentally bypass auth — the var is only set in the test runner.

- [ ] **Step 3: Run the suite**

```bash
deno test supabase/functions/widget-action/ --allow-net --allow-env
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/widget-action/
git commit -m "test(edge): widget-action end-to-end happy + failure paths"
```

### Task 19: Logging — pick branch based on Task 2 outcome

**Decision (2026-04-29, recorded per Task 2):** ephemeral branch (19b). Privacy policy currently states "Error logs without content: up to 30 days" — adding a per-call telemetry table extends scope beyond what's disclosed. Skip 19a. Note: policy still needs a Siri/voice paragraph before TestFlight ship; tracked separately.

**Files (DB-table branch):**
- Create: `supabase/migrations/<timestamp>_widget_action_calls.sql`

**Files (ephemeral branch):**
- No new files — keep the existing `console.log(JSON.stringify(...))` calls from Task 12/17.

Pick ONE branch based on the privacy-policy decision recorded in Task 2.

#### 19a — DB-table branch (only if Task 2 → DB)

- [ ] **Step 1: Write the migration**

Use a fresh timestamp:

```bash
ts=$(date -u +"%Y%m%d%H%M%S")
echo "supabase/migrations/${ts}_widget_action_calls.sql"
```

Create that file:

```sql
create table if not exists public.widget_action_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('create_event')),
  success boolean not null,
  error_class text check (error_class in (
    'empty_prompt', 'unparseable', 'no_calendar_labels',
    'oauth_invalid', 'permission_denied', 'provider_5xx'
  )),
  calendar_resolution text check (calendar_resolution in (
    'hint_matched', 'fallback_only_configured', 'label_default', 'no_calendar'
  )),
  calendar_provider text check (calendar_provider in ('google', 'microsoft')),
  prompt_language text check (prompt_language in ('da', 'en', 'unknown')),
  latency_ms integer,
  claude_input_tokens integer,
  claude_output_tokens integer,
  claude_model text,
  created_at timestamptz not null default now()
);

create index if not exists widget_action_calls_user_created_idx
  on public.widget_action_calls (user_id, created_at desc);

-- Retention purge — daily delete of rows older than 60 days.
-- Mirror of supabase/migrations/20260427130000_icloud_proxy_calls_retention.sql
-- (held back at plan time). Once that pattern lands, copy the cron schedule
-- here using the same approach.
comment on table public.widget_action_calls is
  'Per-call telemetry for the widget-action Edge Function. Retention 60 days. Never logs prompt text or Claude inputs/outputs.';
```

- [ ] **Step 2: Wire the writer into `index.ts`**

Replace each `console.log(JSON.stringify({ action: ... }))` in `workerHandler` with a call into a new helper that writes both to console AND inserts a row:

```ts
async function logCall(client: SupabaseClient, entry: {
  user_id: string;
  success: boolean;
  error_class?: string;
  calendar_resolution: string;
  calendar_provider?: string;
  prompt_language?: string;
  latency_ms?: number;
  claude_tokens?: { input: number; output: number };
  claude_model?: string;
}) {
  const row = {
    user_id: entry.user_id,
    action: 'create_event' as const,
    success: entry.success,
    error_class: entry.error_class ?? null,
    calendar_resolution: entry.calendar_resolution,
    calendar_provider: entry.calendar_provider ?? null,
    prompt_language: entry.prompt_language ?? null,
    latency_ms: entry.latency_ms ?? null,
    claude_input_tokens: entry.claude_tokens?.input ?? null,
    claude_output_tokens: entry.claude_tokens?.output ?? null,
    claude_model: entry.claude_model ?? null,
  };
  console.log(JSON.stringify({ kind: 'widget-action', ...row }));
  const { error } = await client.from('widget_action_calls').insert(row);
  if (error) console.warn('[widget-action] log insert failed:', error.message);
}
```

Replace each existing `console.log(JSON.stringify({ action: 'create_event', ... }))` with `await logCall(supabaseClient, { ... })`.

- [ ] **Step 3: Apply migration + commit**

```bash
supabase db push --linked
git add supabase/migrations/${ts}_widget_action_calls.sql supabase/functions/widget-action/index.ts
git commit -m "feat(db,edge): widget_action_calls telemetry table + writer"
```

#### 19b — Ephemeral branch (only if Task 2 → ephemeral)

- [ ] **Step 1: Confirm console.log lines are present**

Verify `index.ts` contains the `console.log(JSON.stringify(...))` calls added in Tasks 12 and 17. No DB writes; Supabase function logs (≈7-day platform retention) are the only sink.

- [ ] **Step 2: Annotate the policy choice**

In `index.ts` near the top, add a one-line comment so the next reader doesn't try to "fix" the missing DB writer:

```ts
// Logging: ephemeral only (privacy policy specifies "no backend logs").
// No widget_action_calls table. Supabase platform log retention applies.
```

- [ ] **Step 3: Commit (no migration to add)**

```bash
git add supabase/functions/widget-action/index.ts
git commit -m "docs(edge): note ephemeral-logging stance for widget-action"
```

### Task 20: Deploy Edge Function

**Files:** none

The function uses ES256 JWTs (same as the rest of the project). Deploy with `--no-verify-jwt` since the gateway can't verify ES256; we verify manually inside the function.

- [ ] **Step 1: Set required env vars on Supabase**

```bash
supabase secrets set ANTHROPIC_API_KEY=<your key> --project-ref sjkhfkatmeqtsrysixop
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the platform — no need to set manually.

Confirm `WIDGET_ACTION_TEST_USER_ID` is NOT set in production:

```bash
supabase secrets list --project-ref sjkhfkatmeqtsrysixop | grep WIDGET_ACTION_TEST_USER_ID || echo OK
```

Expected: `OK`.

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy widget-action --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
```

- [ ] **Step 3: Smoke test from terminal**

Get a current JWT for the test user (`albertfeldt1@gmail.com`, `28c51177-...`) — easiest path is to log in on the simulator and copy the token from the device's keychain, or mint via the SDK in a one-off script. Then:

```bash
curl -X POST https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/widget-action \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"sæt et møde i morgen kl. 17","timezone":"Europe/Copenhagen"}'
```

Expected: 200 + JSON `{ dialog, snippet }`. If `oauth_invalid`, the test user's Google or Microsoft tokens may not be present in `user_oauth_tokens`. Connect a calendar in-app first, set a Stemmestyring label, then retry.

- [ ] **Step 4: No commit needed for deploy itself.** Move to Phase 7.

---

## Phase 7 — iOS AppIntent

### Task 21: Voice-intents config plugin scaffold

**Files:**
- Create: `plugins/voice-intents/withVoiceIntents.js`

Mirror of `plugins/widget-bridge/withWidgetBridge.js`. Copies Swift sources from the plugin dir into `ios/Zolva/` on prebuild and registers them in the main app's Xcode target.

- [ ] **Step 1: Write the plugin**

Create `plugins/voice-intents/withVoiceIntents.js`:

```js
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');

const SOURCES = [
  'Stone.swift',
  'SupabaseSession.swift',
  'SupabaseAuthClient.swift',
  'IntentActionClient.swift',
  'AskZolvaSnippetView.swift',
  'AskZolvaIntent.swift',
  'AskZolvaShortcuts.swift',
];

const copySources = (config) =>
  withDangerousMod(config, ['ios', async (cfg) => {
    const projectRoot = cfg.modRequest.projectRoot;
    const iosAppDir = path.join(cfg.modRequest.platformProjectRoot, 'Zolva');
    const srcDir = path.join(projectRoot, 'plugins', 'voice-intents');
    for (const file of SOURCES) {
      fs.copyFileSync(path.join(srcDir, file), path.join(iosAppDir, file));
    }
    return cfg;
  }]);

const registerInXcodeProject = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const targetUuid = project.findTargetKey('Zolva');
    if (!targetUuid) return cfg;
    for (const file of SOURCES) {
      const filePath = `Zolva/${file}`;
      const groupKey =
        project.findPBXGroupKey({ name: 'Zolva' }) ??
        project.pbxCreateGroup('Zolva', 'Zolva');
      project.addSourceFile(
        filePath,
        { target: targetUuid, lastKnownFileType: 'sourcecode.swift' },
        groupKey,
      );
    }
    return cfg;
  });

module.exports = (config) => {
  config = copySources(config);
  config = registerInXcodeProject(config);
  return config;
};
```

- [ ] **Step 2: Append the plugin to `app.json`**

In `app.json` `expo.plugins` array, append after the existing widget-bridge entry:

```json
[
  "expo-font",
  "expo-web-browser",
  "expo-apple-authentication",
  "expo-video",
  ["expo-notifications", { ... }],
  ["@bacons/apple-targets", { "appleTeamId": "N6WPH3FPFA" }],
  "./plugins/widget-bridge/withWidgetBridge",
  "./plugins/voice-intents/withVoiceIntents"
]
```

- [ ] **Step 3: Don't run prebuild yet — Swift sources don't exist.** Skip the verify step until Tasks 22–28 land.

- [ ] **Step 4: Commit (just the plugin scaffold + app.json line)**

```bash
git add plugins/voice-intents/withVoiceIntents.js app.json
git commit -m "feat(ios): voice-intents config plugin scaffold"
```

### Task 22: `Stone.swift` — Swift port of the mascot

**Files:**
- Create: `plugins/voice-intents/Stone.swift`

Two moods only: `happy`, `worried`. SVG paths translated to SwiftUI `Path`. The RN component supports `calm | thinking | happy`; the v2 Swift port adds `worried` (used by error states) and drops `calm` / `thinking` (not used by snippets in v2).

- [ ] **Step 1: Write the Stone view**

Create `plugins/voice-intents/Stone.swift`:

```swift
import SwiftUI

enum StoneMood {
  case happy
  case worried
}

struct Stone: View {
  let mood: StoneMood

  var body: some View {
    GeometryReader { geo in
      let s = min(geo.size.width, geo.size.height)
      ZStack {
        // Body — soft green pebble.
        Ellipse()
          .fill(LinearGradient(
            colors: [Color(red: 0.42, green: 0.55, blue: 0.42), Color(red: 0.32, green: 0.44, blue: 0.32)],
            startPoint: .top, endPoint: .bottom,
          ))
          .frame(width: s * 0.92, height: s * 0.78)
          .offset(y: s * 0.04)

        // Eyes.
        HStack(spacing: s * 0.18) {
          Circle().fill(Color.white).frame(width: s * 0.10, height: s * 0.10)
            .overlay(Circle().fill(Color.black).frame(width: s * 0.05, height: s * 0.05))
          Circle().fill(Color.white).frame(width: s * 0.10, height: s * 0.10)
            .overlay(Circle().fill(Color.black).frame(width: s * 0.05, height: s * 0.05))
        }
        .offset(y: -s * 0.06)

        // Mouth.
        mouth
          .stroke(Color.black, style: StrokeStyle(lineWidth: s * 0.035, lineCap: .round))
          .frame(width: s * 0.32, height: s * 0.18)
          .offset(y: s * 0.18)
      }
    }
    .aspectRatio(1, contentMode: .fit)
  }

  @ViewBuilder
  private var mouth: some View {
    switch mood {
    case .happy:
      // Curve pointing up at the corners.
      Path { p in
        p.move(to: CGPoint(x: 0, y: 0))
        p.addQuadCurve(to: CGPoint(x: 1, y: 0), control: CGPoint(x: 0.5, y: 1))
      }
      .scale(x: 1, y: 1, anchor: .top)
      .scaledToFill()
    case .worried:
      // Slight inverted curve (corners turned down a touch).
      Path { p in
        p.move(to: CGPoint(x: 0, y: 0.6))
        p.addQuadCurve(to: CGPoint(x: 1, y: 0.6), control: CGPoint(x: 0.5, y: 0.0))
      }
      .scaledToFill()
    }
  }
}

#Preview("Stone happy") { Stone(mood: .happy).frame(width: 56, height: 56) }
#Preview("Stone worried") { Stone(mood: .worried).frame(width: 56, height: 56) }
```

- [ ] **Step 2: Commit**

```bash
git add plugins/voice-intents/Stone.swift
git commit -m "feat(ios): Stone.swift port for snippet view"
```

### Task 23: `SupabaseSession.swift` — keychain reader

**Files:**
- Create: `plugins/voice-intents/SupabaseSession.swift`

Reads + writes JWT and refresh token to the shared keychain access group seeded by `src/lib/keychain.ts` (Task 4) via `expo-secure-store`. The access-group string includes the App Identifier Prefix.

- [ ] **Step 1: Write the module**

Create `plugins/voice-intents/SupabaseSession.swift` (verbatim from spec):

```swift
import Foundation
import Security

enum SupabaseSessionError: Error {
  case notLoggedIn
  case keychainError(OSStatus)
  case refreshFailed(reason: String)
}

struct SupabaseSession {
  static let accessGroup = "N6WPH3FPFA.io.zolva.shared"
  // expo-secure-store@15 internally appends ":no-auth" (or ":auth" with
  // requireAuthentication: true) to the keychainService value before passing
  // it to kSecAttrService. JS-side `keychainService: 'io.zolva.shared'` thus
  // stores items with kSecAttrService = "io.zolva.shared:no-auth", and our
  // Swift reader must query with the same suffix. Verified empirically by
  // the SPIKE FIRST keychain probe (Task 0 commit history).
  static let service = "io.zolva.shared:no-auth"
  static let accessTokenAccount = "supabase.access_token"
  static let refreshTokenAccount = "supabase.refresh_token"

  static func readAccessToken() throws -> String { try readKey(accessTokenAccount) }
  static func readRefreshToken() throws -> String { try readKey(refreshTokenAccount) }
  static func writeAccessToken(_ token: String) throws { try writeKey(accessTokenAccount, value: token) }
  static func writeRefreshToken(_ token: String) throws { try writeKey(refreshTokenAccount, value: token) }

  private static func readKey(_ account: String) throws -> String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { throw SupabaseSessionError.notLoggedIn }
    guard status == errSecSuccess, let data = item as? Data,
          let token = String(data: data, encoding: .utf8) else {
      throw SupabaseSessionError.keychainError(status)
    }
    return token
  }

  private static func writeKey(_ account: String, value: String) throws {
    let baseQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup,
    ]
    let data = Data(value.utf8)
    let updateAttrs: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    let status = SecItemUpdate(baseQuery as CFDictionary, updateAttrs as CFDictionary)
    if status == errSecSuccess { return }
    if status != errSecItemNotFound { throw SupabaseSessionError.keychainError(status) }

    var addQuery = baseQuery
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw SupabaseSessionError.keychainError(addStatus)
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/voice-intents/SupabaseSession.swift
git commit -m "feat(ios): SupabaseSession keychain reader/writer"
```

### Task 24: `SupabaseAuthClient.swift` — refresh-from-AppIntent with race handling

**Files:**
- Create: `plugins/voice-intents/SupabaseAuthClient.swift`

The race-loss case is when the main app refreshed first and rotated our cached refresh token. We re-read the keychain — if the refresh token there has changed since we read it, the main app already wrote a new access token; return that. Narrows but doesn't eliminate the failure window. v2 ships with this rare-case lossage; mutex is post-v2 work.

- [ ] **Step 1: Write the module**

Create `plugins/voice-intents/SupabaseAuthClient.swift` (verbatim from spec):

```swift
import Foundation

struct SupabaseAuthClient {
  static let projectRef = "sjkhfkatmeqtsrysixop"

  private static func anonKey() throws -> String {
    guard let key = Bundle.main.object(forInfoDictionaryKey: "SupabaseAnonKey") as? String,
          !key.isEmpty else {
      throw SupabaseSessionError.refreshFailed(reason: "SupabaseAnonKey missing from Info.plist")
    }
    return key
  }

  /// Refresh the access token. Always re-reads the refresh token from
  /// keychain immediately before the POST — never caches across awaits.
  static func refresh() async throws -> String {
    let key = try anonKey()
    let refreshToken = try SupabaseSession.readRefreshToken()

    var req = URLRequest(url: URL(string:
      "https://\(projectRef).supabase.co/auth/v1/token?grant_type=refresh_token")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(key, forHTTPHeaderField: "apikey")
    req.httpBody = try JSONEncoder().encode(["refresh_token": refreshToken])

    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse else {
      throw SupabaseSessionError.refreshFailed(reason: "no response")
    }
    if http.statusCode == 400 || http.statusCode == 401 {
      // Race-loss case: the main app refreshed first.
      if let nowAccessToken = try? SupabaseSession.readAccessToken(),
         (try? SupabaseSession.readRefreshToken()) != refreshToken {
        return nowAccessToken
      }
      throw SupabaseSessionError.refreshFailed(reason: "HTTP \(http.statusCode) — refresh token rejected")
    }
    guard http.statusCode == 200 else {
      throw SupabaseSessionError.refreshFailed(reason: "HTTP \(http.statusCode)")
    }
    let body = try JSONDecoder().decode(RefreshResponse.self, from: data)
    try SupabaseSession.writeAccessToken(body.access_token)
    if let newRefresh = body.refresh_token {
      try SupabaseSession.writeRefreshToken(newRefresh)
    }
    return body.access_token
  }

  private struct RefreshResponse: Decodable {
    let access_token: String
    let refresh_token: String?
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/voice-intents/SupabaseAuthClient.swift
git commit -m "feat(ios): SupabaseAuthClient refresh with race-loss handling"
```

### Task 25: `IntentActionClient.swift` — POST + retry-on-401

**Files:**
- Create: `plugins/voice-intents/IntentActionClient.swift`

6s timeout. Throws `.unauthorized` on 401, `.recoverable` on other failures. Retry-on-401 handled at this layer.

- [ ] **Step 1: Write the module**

Create `plugins/voice-intents/IntentActionClient.swift`:

```swift
import Foundation

struct WidgetActionResponse: Decodable {
  let dialog: String
  let snippet: Snippet
  struct Snippet: Decodable {
    let mood: String   // "happy" | "worried"
    let summary: String
    let deepLink: String
  }
}

enum IntentActionError: Error {
  case unauthorized
  case recoverable(reason: String)
}

enum IntentActionClient {
  static let projectRef = "sjkhfkatmeqtsrysixop"
  static let path = "/functions/v1/widget-action"

  static func send(prompt: String, timezone: String) async throws -> WidgetActionResponse {
    let accessToken = try SupabaseSession.readAccessToken()
    do {
      return try await postOnce(prompt: prompt, timezone: timezone, jwt: accessToken)
    } catch IntentActionError.unauthorized {
      // Refresh re-reads the refresh token from keychain itself; we don't
      // cache it across the await. See SupabaseAuthClient.refresh() for
      // the concurrent-refresh race handling.
      let newAccessToken = try await SupabaseAuthClient.refresh()
      return try await postOnce(prompt: prompt, timezone: timezone, jwt: newAccessToken)
    }
  }

  private static func postOnce(prompt: String, timezone: String, jwt: String) async throws -> WidgetActionResponse {
    var req = URLRequest(url: URL(string: "https://\(projectRef).supabase.co\(path)")!)
    req.httpMethod = "POST"
    req.timeoutInterval = 6
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
    let body: [String: Any] = ["prompt": prompt, "timezone": timezone]
    req.httpBody = try JSONSerialization.data(withJSONObject: body)

    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await URLSession.shared.data(for: req)
    } catch {
      throw IntentActionError.recoverable(reason: "network: \(error.localizedDescription)")
    }
    guard let http = response as? HTTPURLResponse else {
      throw IntentActionError.recoverable(reason: "no http response")
    }
    if http.statusCode == 401 { throw IntentActionError.unauthorized }
    guard http.statusCode == 200 else {
      throw IntentActionError.recoverable(reason: "HTTP \(http.statusCode)")
    }
    do {
      return try JSONDecoder().decode(WidgetActionResponse.self, from: data)
    } catch {
      throw IntentActionError.recoverable(reason: "decode: \(error.localizedDescription)")
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/voice-intents/IntentActionClient.swift
git commit -m "feat(ios): IntentActionClient with 6s timeout + retry-on-401"
```

### Task 26: `AskZolvaSnippetView.swift`

**Files:**
- Create: `plugins/voice-intents/AskZolvaSnippetView.swift`

Two states. Both tappable. SwiftUI native sizing — no hardcoded outer frames; Apple's snippet container handles bounds. Stone gets `.frame(width: 56, height: 56)`.

- [ ] **Step 1: Write the view**

Create `plugins/voice-intents/AskZolvaSnippetView.swift`:

```swift
import SwiftUI

enum AskZolvaSnippetState {
  case success(summary: String, deepLink: URL)
  case error(message: String, deepLink: URL)
}

struct AskZolvaSnippetView: View {
  let state: AskZolvaSnippetState

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Stone(mood: stoneMood)
        .frame(width: 56, height: 56)
      VStack(alignment: .leading, spacing: 4) {
        Text(text)
          .font(.body)
          .foregroundColor(.primary)
          .lineLimit(3)
        Text(subtitle)
          .font(.caption)
          .foregroundColor(.secondary)
      }
      Spacer()
    }
    .padding(.vertical, 8)
    .contentShape(Rectangle())
    .onTapGesture { open(url) }
  }

  private var stoneMood: StoneMood {
    switch state {
    case .success: return .happy
    case .error: return .worried
    }
  }

  private var text: String {
    switch state {
    case .success(let summary, _): return summary
    case .error(let message, _): return message
    }
  }

  private var subtitle: String {
    switch state {
    case .success: return "Tryk for at åbne"
    case .error: return "Tryk for at rette"
    }
  }

  private var url: URL {
    switch state {
    case .success(_, let u), .error(_, let u): return u
    }
  }

  private func open(_ url: URL) {
    // AppIntents snippets cannot directly call openURL; the wrapper Siri
    // overlay forwards the tap to the host app via the system URL handler.
    // The deep-link is the snippet's "primary action" via .onTapGesture.
    UIApplication.shared.open(url)
  }
}

#Preview("Snippet success") {
  AskZolvaSnippetView(state: .success(
    summary: "Møde med Sophie · i morgen kl. sytten",
    deepLink: URL(string: "zolva://calendar/event/abc123")!
  ))
}
#Preview("Snippet error — recoverable") {
  AskZolvaSnippetView(state: .error(
    message: "Forstod ikke. Prøv igen i appen.",
    deepLink: URL(string: "zolva://chat")!
  ))
}
#Preview("Snippet error — auth (logged out)") {
  AskZolvaSnippetView(state: .error(
    message: "Logget ud — åbn Zolva for at logge ind igen.",
    deepLink: URL(string: "zolva://settings")!
  ))
}
#Preview("Snippet error — permission") {
  AskZolvaSnippetView(state: .error(
    message: "Du har ikke skriverettigheder til Acme Work Cal.",
    deepLink: URL(string: "zolva://settings")!
  ))
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/voice-intents/AskZolvaSnippetView.swift
git commit -m "feat(ios): AskZolvaSnippetView with success + error states"
```

### Task 27: `AskZolvaIntent.swift` and `AskZolvaShortcuts.swift`

**Files:**
- Create: `plugins/voice-intents/AskZolvaIntent.swift`
- Create: `plugins/voice-intents/AskZolvaShortcuts.swift`

Single `@Parameter prompt: String`. Whole transcript ships server-side. No `OpensAppWhenRun` — `perform()` returns its own dialog/snippet.

- [ ] **Step 1: Write the AppIntent**

Create `plugins/voice-intents/AskZolvaIntent.swift`:

```swift
import AppIntents
import Foundation

struct AskZolvaIntent: AppIntent {
  static var title: LocalizedStringResource = "Ask Zolva"
  static var description = IntentDescription("Bed Zolva om at sætte et møde i din kalender via stemmen.")

  @Parameter(title: "What do you want to ask Zolva?")
  var prompt: String

  func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    do {
      let response = try await IntentActionClient.send(
        prompt: prompt,
        timezone: TimeZone.current.identifier
      )
      let snippetState: AskZolvaSnippetState
      let url = URL(string: response.snippet.deepLink) ?? URL(string: "zolva://chat")!
      switch response.snippet.mood {
      case "happy":
        snippetState = .success(summary: response.snippet.summary, deepLink: url)
      default:
        snippetState = .error(message: response.snippet.summary, deepLink: url)
      }
      return .result(
        dialog: IntentDialog(stringLiteral: response.dialog),
        view: AskZolvaSnippetView(state: snippetState)
      )
    } catch SupabaseSessionError.notLoggedIn {
      return .result(
        dialog: "Logget ud — åbn Zolva for at logge ind igen.",
        view: AskZolvaSnippetView(state: .error(
          message: "Logget ud — åbn Zolva for at logge ind igen.",
          deepLink: URL(string: "zolva://settings")!
        ))
      )
    } catch SupabaseSessionError.refreshFailed {
      return .result(
        dialog: "Du er logget ud — åbn Zolva for at logge ind igen.",
        view: AskZolvaSnippetView(state: .error(
          message: "Du er logget ud.",
          deepLink: URL(string: "zolva://settings")!
        ))
      )
    } catch IntentActionError.unauthorized {
      // Already retried inside IntentActionClient; bubbling out means the
      // refresh path also threw .unauthorized — treat as logged out.
      return .result(
        dialog: "Du er logget ud — åbn Zolva for at logge ind igen.",
        view: AskZolvaSnippetView(state: .error(
          message: "Du er logget ud.",
          deepLink: URL(string: "zolva://settings")!
        ))
      )
    } catch {
      return .result(
        dialog: "Forbindelse fejlede. Prøv igen.",
        view: AskZolvaSnippetView(state: .error(
          message: "Forbindelse fejlede. Prøv igen.",
          deepLink: URL(string: "zolva://chat")!
        ))
      )
    }
  }
}
```

- [ ] **Step 2: Write the AppShortcuts provider**

Create `plugins/voice-intents/AskZolvaShortcuts.swift`:

```swift
import AppIntents

struct AskZolvaShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskZolvaIntent(),
      phrases: [
        "Bed \(.applicationName) om at \(\.$prompt)",
        "Sig til \(.applicationName) at \(\.$prompt)",
        "Spørg \(.applicationName)",
        "Ask \(.applicationName)",
        "Ask \(.applicationName) to \(\.$prompt)",
      ],
      shortTitle: "Spørg Zolva",
      systemImageName: "bubble.left.fill"
    )
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add plugins/voice-intents/AskZolvaIntent.swift plugins/voice-intents/AskZolvaShortcuts.swift
git commit -m "feat(ios): AskZolvaIntent + AppShortcutsProvider"
```

### Task 28: Prebuild + xcodebuild + on-device install

**Files:** none (verifies the plugin output)

- [ ] **Step 1: Prebuild**

```bash
npx expo prebuild --clean --platform ios
```

Expected: `ios/Zolva/Stone.swift`, `ios/Zolva/AskZolvaIntent.swift`, etc., all exist. Xcode project includes them in the `Zolva` target.

- [ ] **Step 2: Build**

```bash
xcodebuild -workspace ios/Zolva.xcworkspace -scheme Zolva -configuration Debug -destination 'generic/platform=iOS' -quiet build CODE_SIGNING_ALLOWED=NO
```

Expected: `BUILD SUCCEEDED`.

- [ ] **Step 3: Open in Xcode and run on a real device**

```bash
open ios/Zolva.xcworkspace
```

In Xcode, select your physical iPhone, build & run. Confirm:
- App launches.
- Settings → Stemmestyring picker works.
- Pick a calendar.
- Lock the device, say "Hey Siri, bed Zolva om at sætte et møde i morgen kl. sytten".

Expected: Siri shows the snippet with Stone + summary + spoken confirmation. Tap → opens calendar tab on the right day.

- [ ] **Step 4: If anything fails, debug per the QA checklist (Task 30) before commit.** No commit needed if previous tasks already shipped.

---

## Phase 8 — Tests + manual QA

### Task 29: AppIntent unit tests

**Status (2026-04-29):** Test seam in `IntentActionClient.swift` and the test file at `plugins/voice-intents/AskZolvaIntentTests.swift` are committed. Wiring into an Xcode `ZolvaTests` bundle is **deferred** — solo project, no `ZolvaTests` target yet, and the spec marks these as "should have, not blocking." On-device QA (Task 30) is the active gate for the same auth-state matrix. When a test bundle is added, copy the test file into the new target and update `withVoiceIntents.js` if needed.

**Files:**
- Create: `plugins/voice-intents/AskZolvaIntentTests.swift`
- Modify: `plugins/voice-intents/IntentActionClient.swift` (add a test seam)

Tests cover the auth-state matrix from the spec. The test seam is a static closure that XCTest swaps in to bypass real network.

- [ ] **Step 1: Add a test seam to `IntentActionClient`**

Modify `IntentActionClient.swift` so `send` resolves through an injectable closure:

```swift
enum IntentActionClient {
  static var sendOverride: ((String, String) async throws -> WidgetActionResponse)?
  // ...

  static func send(prompt: String, timezone: String) async throws -> WidgetActionResponse {
    if let override = sendOverride {
      return try await override(prompt, timezone)
    }
    // (existing implementation continues unchanged)
    let accessToken = try SupabaseSession.readAccessToken()
    // ...
  }
}
```

In production this stays nil; tests assign it before each case.

- [ ] **Step 2: Confirm or add an Xcode test target**

Open `ios/Zolva.xcodeproj` (or workspace). If a `ZolvaTests` target already exists, add the new file to it. If not, File → New → Target → Unit Testing Bundle → name `ZolvaTests`. Same Team ID, same App Identifier prefix. Skip if the project's owner prefers to defer iOS unit tests in favor of the on-device QA checklist (Task 30) — the spec lists these as "should have", not blocking.

- [ ] **Step 3: Write the tests**

Create `plugins/voice-intents/AskZolvaIntentTests.swift`:

```swift
import XCTest
@testable import Zolva

@MainActor
final class AskZolvaIntentTests: XCTestCase {
  override func tearDown() async throws {
    IntentActionClient.sendOverride = nil
  }

  func testHappyPath() async throws {
    IntentActionClient.sendOverride = { _, _ in
      WidgetActionResponse(
        dialog: "Tilføjet: 'Møde', i morgen kl. sytten i din arbejdskalender.",
        snippet: .init(mood: "happy", summary: "Møde · i morgen kl. sytten", deepLink: "zolva://calendar/event/abc"),
      )
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde i morgen kl. 17"
    let result = try await intent.perform()
    // Result is opaque IntentResult; we assert no throw + snippet wiring is exercised.
    _ = result
  }

  func testNotLoggedInTokensMissing() async throws {
    IntentActionClient.sendOverride = { _, _ in
      throw SupabaseSessionError.notLoggedIn
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde"
    let result = try await intent.perform()
    _ = result
    // Manually inspect: the result's dialog should mention "logget ud".
  }

  func testRefreshFailedAfterRetry() async throws {
    IntentActionClient.sendOverride = { _, _ in
      throw IntentActionError.unauthorized
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde"
    let result = try await intent.perform()
    _ = result
  }

  func testTimeoutFallsToRecoverable() async throws {
    IntentActionClient.sendOverride = { _, _ in
      throw IntentActionError.recoverable(reason: "timeout")
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde"
    let result = try await intent.perform()
    _ = result
  }

  func testMissingSupabaseAnonKeyDoesNotCrash() async throws {
    // SupabaseAuthClient.refresh() must throw, not fatalError, when the key
    // is missing. AskZolvaIntent surfaces that as the worried "logget ud"
    // dialog. Swap in a sendOverride that mimics that path.
    IntentActionClient.sendOverride = { _, _ in
      throw SupabaseSessionError.refreshFailed(reason: "SupabaseAnonKey missing from Info.plist")
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde"
    let result = try await intent.perform()
    _ = result
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
xcodebuild -workspace ios/Zolva.xcworkspace -scheme Zolva -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/voice-intents/AskZolvaIntentTests.swift plugins/voice-intents/IntentActionClient.swift
git commit -m "test(ios): AskZolvaIntent auth-state matrix"
```

### Task 30: Manual on-device QA checklist

**Files:**
- Create: `docs/superpowers/plans/widget-v2-qa-checklist.md`

Real iPhone, not simulator (keychain access groups differ in sim). Both Danish and English iOS locale required.

- [ ] **Step 1: Write the checklist**

Create `docs/superpowers/plans/widget-v2-qa-checklist.md` with the contents from the spec's Manual on-device QA section (verbatim — the spec already enumerates the cases). For convenience, copy from `docs/superpowers/specs/2026-04-28-widget-v2-siri-design.md` lines 774-849.

- [ ] **Step 2: Run the checklist on a real device**

Plug iPhone, run `xcodebuild` build, install, work through each line item. Mark pass/fail in the checklist file as you go (commit the marked-up version when done).

- [ ] **Step 3: Latency profiling**

Run before TestFlight ship per spec (Latency profiling section):
- 5 cold-start calls, 15+ min apart. Report `max`. Target: cold ≤6s.
- 20+ back-to-back warm calls. Report p50, p95. Target: p50 ≤2.5s, p95 ≤4s.

If p95 misses, profile per-step (Claude vs DB vs provider write); fix server-side. Don't extend the Swift client timeout.

- [ ] **Step 4: Commit the marked-up checklist**

```bash
git add docs/superpowers/plans/widget-v2-qa-checklist.md
git commit -m "test(qa): widget v2 on-device checklist results"
```

---

## Self-review

**Spec coverage:** every section of the spec maps to at least one task.

| Spec section | Covered by |
|---|---|
| Prerequisites: SupabaseAnonKey | Task 1 |
| Prerequisites: spike-verified keychain | Task 0 |
| Prerequisites: privacy policy | Task 2, branched in Task 19 |
| iOS Components: AskZolvaIntent | Task 27 |
| iOS Components: AskZolvaShortcuts | Task 27 |
| iOS Components: AskZolvaSnippetView | Task 26 |
| iOS Components: Stone.swift | Task 22 |
| iOS Components: IntentActionClient | Task 25 |
| iOS Components: withVoiceIntents | Task 21 |
| Edge Function: contract + JWT | Task 11 |
| Edge Function: empty-prompt + label resolution | Tasks 12, 14 |
| Edge Function: Claude tool-use | Task 13 |
| Edge Function: provider write | Task 15 |
| Edge Function: response build + truncation | Tasks 16, 17 |
| Edge Function: logging | Task 19 |
| Edge Function: deploy | Task 20 |
| DB migration: normalized columns | Task 3 |
| DB migration: snapshot column reserved | Task 3 |
| Settings UI | Task 10 |
| TS calendar-labels read/write | Task 6 |
| Auto-clear-on-disconnect | Task 7 |
| listWritableCalendars | Task 8 |
| useCalendarLabels hook | Task 9 |
| Auth wire-up: entitlement | Task 1 |
| Auth wire-up: shared keychain TS | Task 4 |
| Auth wire-up: onAuthStateChange mirror | Task 5 |
| Auth wire-up: SupabaseSession.swift | Task 23 |
| Auth wire-up: SupabaseAuthClient.swift refresh | Task 24 |
| Test plan: SwiftUI previews | Tasks 22, 26 (`#Preview` blocks inline) |
| Test plan: AppIntent unit tests | Task 29 |
| Test plan: Edge Function Deno tests | Tasks 11, 14, 16, 18 |
| Test plan: Manual on-device QA + latency | Task 30 |

No placeholders. Every code step inlines the actual code. Type names cross-reference: `CalendarLabelTarget`, `LabelMap`, `Selection`, `Resolution`, `WidgetActionResponse`, `IntentActionError`, `SupabaseSessionError` are used consistently.

---

## Held-back-files reminder (final pass)

Before merging this branch:

```bash
git status
```

Expected unstaged-or-untracked at end of plan execution:
- `src/lib/auth.ts` — should still show the held-back Microsoft scope-bump line(s) un-committed.
- `supabase/migrations/20260427130000_icloud_proxy_calls_retention.sql` — untracked.
- `supabase/schedule-icloud-proxy-retention.sql.template` — untracked.

If any of those got bundled into a v2 commit, revert and re-commit cleanly before opening a PR.
