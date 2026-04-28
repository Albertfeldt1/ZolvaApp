# Widget v2 — Siri Voice Calendar Create

**Status:** spec, ready for implementation plan.
**Author:** Albert Feldt + Claude Opus 4.7.
**Date:** 2026-04-28.
**Predecessor:** `docs/superpowers/specs/2026-04-27-widgets-design.md` (v1 medium widget — already shipped to main).

---

## Goal

Let the user dispatch a calendar-create one-liner to Zolva by voice without launching the app. Driving use case: user is reading a friend's text on the home screen ("lets meet tomorrow at five") and wants to add the meeting to their calendar in a single Siri turn.

iOS Constraint: WidgetKit cannot accept text input on the widget surface, and a widget tap cannot programmatically invoke the Siri voice overlay. The path that delivers "voice → action without opening the app" is `AppShortcut` — invokable via "Hey Siri" or via the Action Button on iPhone 15/16 Pro. v2 ships exactly that, leaving the v1 widget chat row's deep-link-to-chat behavior unchanged.

## Scope

**In scope (single voice action):** create calendar event on Google or Microsoft.

**Explicitly out of scope for v2:** update event, delete event, add reminder, mark reminder done, remove reminder, calendar reads, mail reads, free-form chat over voice, iCloud calendar writes, multi-turn voice conversation, custom Siri snippet UI for the v1 widget surface.

Reminders are deferred because Zolva reminders currently live in client-side AsyncStorage; voice-from-Siri can't write to AsyncStorage without the app being open. Moving reminders server-side is its own separately-scoped piece of work. Update/delete via voice is awkward (needs to find the right event first) and is naturally an in-app gesture; deferred to "future feature" status.

## Architecture

```
[ User ]
   ↓ "Hey Siri, bed Zolva om at sætte et møde i morgen kl. 17"
[ iOS Siri ]
   ↓ voice → text, fills String parameter on AskZolvaIntent
[ AskZolvaIntent.perform() ]   ←— runs in app's background process
   ↓ POST { transcript, timezone } + Bearer JWT
[ Supabase Edge Function: widget-action ]
   ↓ Claude tool-use (single tool: create_calendar_event)
   ↓ enum→id calendar resolution (hint → label-default → fail)
   ↓ Google Calendar API or Microsoft Graph (via Supabase OAuth broker)
   ↓ returns { dialog, snippet: { mood, summary, deepLink } }
[ AppIntent ]
   ↓ .result(dialog: snippet:)
[ Siri overlay ]
   shows Stone + summary + spoken response
```

One voice action, one Siri trigger surface, one server endpoint, one Stone snippet.

### Components new in v2

- **iOS:** `AskZolvaShortcut` (AppShortcutsProvider), `AskZolvaIntent` (AppIntent), `AskZolvaSnippetView` (SwiftUI), `Stone.swift` Swift port, `SupabaseSession.swift`, `SupabaseAuthClient.swift`, `IntentActionClient.swift`. All under `plugins/voice-intents/` and copied into the main app target on prebuild via a config plugin (`withVoiceIntents.js`).
- **Edge Function:** `supabase/functions/widget-action/index.ts` (Deno).
- **Database:** four new columns on `user_profiles` for normalized calendar-label storage, plus a transient JSONB snapshot column for restore-on-reconnect.
- **Settings UI:** new "Stemmestyring" sub-section under existing Connections, with two label pickers (Work, Personal).
- **App configuration:** Keychain access group entitlement, mirroring of Supabase session into shared keychain on auth state changes.

### Components NOT in v2

- No reminder voice path.
- No update/delete voice path.
- No SnippetView for the v1 widget surface (Stone-in-Siri only; v1 widget keeps its existing text rendering).
- No iCloud calendar voice writes.
- No realtime subscription for `user_profiles` (single-device for now).

---

## iOS Components

All Swift sources live under `plugins/voice-intents/` (committed source-of-truth, mirroring the `plugins/widget-bridge/` pattern from v1) and are copied into `ios/Zolva/` on every `expo prebuild` via the new `withVoiceIntents.js` config plugin. They compile into the main app target — AppIntents need to live where Siri/Shortcuts can find them, and `perform()` runs in the app's own background process. Same target = same default Keychain access group context, plus the explicit shared access group declared below.

### `AskZolvaIntent.swift`

```swift
struct AskZolvaIntent: AppIntent {
  static var title: LocalizedStringResource = "Ask Zolva"
  @Parameter(title: "What do you want to ask Zolva?")
  var prompt: String

  func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    let response = try await IntentActionClient.send(
      prompt: prompt,
      timezone: TimeZone.current.identifier
    )
    return .result(
      dialog: IntentDialog(stringLiteral: response.dialog),
      view: AskZolvaSnippetView(state: response.snippet.toState())
    )
  }
}
```

The `@Parameter String prompt` is a value parameter, not a structured one. Apple's framework prompts the user via voice for the value when the user invokes a bare phrase ("Hey Siri, spørg Zolva") without supplying it. The whole transcript ships server-side as one string; semantic extraction (date, calendar name, etc.) happens in the Edge Function via Claude tool-use, not in the AppIntent.

### `AskZolvaShortcuts.swift`

```swift
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

Two with-parameter Danish forms ("Bed Zolva om at..." / "Sig til Zolva at...") match natural imperative speech. The bare invocation phrases let Apple prompt for the parameter via voice when the user doesn't include it in the wake phrase. English forms unchanged.

### `AskZolvaSnippetView.swift`

```swift
enum AskZolvaSnippetState {
  case success(summary: String, deepLink: URL)        // tap → opens to created event
  case error(message: String, deepLink: URL)          // tap → recovery action
}
```

Both states tappable. SwiftUI native sizing — no hardcoded frames; Apple's snippet container handles bounds. Stone gets `.frame(width: 56, height: 56)` for visual weight; surrounding layout flexes.

### `Stone.swift`

Swift port of the RN `<Stone>` component. Two moods only for v2 (`happy`, `worried`). Reuses the existing PNG/SVG assets from the app's main asset catalog.

### `IntentActionClient.swift`

Single async POST to `https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/widget-action` with `Authorization: Bearer <JWT>`. Request body: `{ prompt, timezone }`. Decodes JSON response into `WidgetActionResponse { dialog: String, snippet: { mood, summary, deepLink } }`. Timeout: **6 seconds** (cold Edge Function + Claude + provider write needs the headroom; still inside Siri's ~10s budget). Throws `.unauthorized` on HTTP 401, `.recoverable(reason)` on other failures. Retry-on-401 handled at this layer — see Auth Wire-up below.

### `withVoiceIntents.js`

Config plugin mirroring `withWidgetBridge.js`. Copies the Swift files from `plugins/voice-intents/` into `ios/Zolva/` on prebuild and registers them in the main app's Xcode target via `withXcodeProject`. Same `'Zolva'` (not `'ZolvaApp'`) target name fix that v1 needed.

`app.json` plugin registration appended after the existing v1 widget bridge:
```json
"plugins": [
  ...,
  ["@bacons/apple-targets", { "appleTeamId": "N6WPH3FPFA" }],
  "./plugins/widget-bridge/withWidgetBridge",
  "./plugins/voice-intents/withVoiceIntents"
]
```

### What we get for free

- **Action Button binding** on iPhone 15/16 Pro: AppShortcuts auto-register, user can pick "Spørg Zolva" in Settings → Action Button.
- **Lock-screen / Spotlight invocation:** Siri suggests the shortcut after a few uses.
- **Siri voice transcription:** Apple does it; we never deal with audio.

### What we explicitly do not do

- No `IntentParameterSummary` / structured parameter resolution — whole transcript ships as one string, Claude does structured extraction.
- No `OpensAppWhenRun` — perform() returns its own dialog/snippet, app is never foregrounded.
- No NSUserActivity bridging — the deep-link in error/success states uses the existing `zolva://` scheme already wired in v1's deep-link handler.

---

## Edge Function (`widget-action`)

**Path:** `supabase/functions/widget-action/index.ts` (Deno).
**Deployed with:** `--no-verify-jwt` (project uses ES256 — gateway can't verify; we verify manually inside the function).

### Request / response contract

```ts
// POST /functions/v1/widget-action
// Authorization: Bearer <Supabase JWT>
type Request = {
  prompt: string;        // raw transcript from Siri
  timezone: string;      // IANA, populated by AppIntent from TimeZone.current.identifier
  locale?: string;       // optional, e.g. "da-DK" — for natural-time formatting
};

type Response = {
  dialog: string;        // spoken response, ≤120 chars
  snippet: {
    mood: 'happy' | 'worried';
    summary: string;     // visual summary, ≤80 chars
    deepLink: string;    // ALWAYS present — success deep-links to event, error to recovery
  };
};
```

### JWT verification

Module-scope JWKS cache, fetched once on cold start from `https://sjkhfkatmeqtsrysixop.supabase.co/auth/v1/.well-known/jwks.json`. Match JWT header `kid` against the JWKS key set — do not hardcode a single public key (Supabase rotates, locking to one will silently break). On verification failure: refresh JWKS once, retry verification, then 401. Cache lives the lifetime of the warm instance (~5–15 min).

### Pipeline

1. **Auth.** Verify Bearer JWT against JWKS. Extract `sub` as user id. On failure → 401 + worried snippet "Logget ud — åbn Zolva for at logge ind igen." (deep-link `zolva://settings`).

2. **Empty-prompt guard.** If `prompt.trim() === ''` → worried-but-friendly: dialog "Hvad skulle jeg sætte op?" snippet "Sig fx 'sæt et møde i morgen kl. 17'." Edge case — Apple usually prompts for the parameter before invoking us.

3. **Resolve calendar mapping.** Read the user's profile columns (`work_calendar_provider`, `work_calendar_id`, `personal_calendar_provider`, `personal_calendar_id`). If both label pairs are null → worried snippet "Du har ikke valgt en arbejds- eller privatkalender. Åbn Zolva for at vælge." (deep-link `zolva://settings`). Otherwise carry the mapping forward — actual selection happens after Claude returns.

4. **Claude tool-use call.** One Anthropic Messages API call with `tool_choice: { type: 'tool', name: 'create_calendar_event' }` to force a structured response.

   System prompt structure (in both DA + EN):
   > "You parse a single calendar-create request. The user's timezone is `{tz}`. Return a tool call with title, start, optionally end, optionally calendar_label. If unparseable, return title='UNPARSEABLE'."

   Tool schema:
   ```json
   {
     "title": "string — short title for the event",
     "start": "string — ISO 8601 with offset in user's timezone",
     "end": "string — ISO 8601 with offset, OPTIONAL — server defaults if omitted",
     "calendar_label": "'work' | 'personal' | null — only set if user mentioned a specific calendar"
   }
   ```

   Server-side `end` default: if Claude omits, apply `end = start + 60 minutes`. Documented as v2 known-imperfect — most events aren't exactly 60 min, but acceptable for the driving use case. Future v2.x: heuristic ("lunch" → 45, "1:1" → 30) or explicit duration extraction.

5. **Calendar selection (enum→id lookup).**
    - Claude returned `calendar_label = 'work'` AND `work_calendar_*` columns are set → use them. Log `calendar_resolution: 'hint_matched'`.
    - Claude returned no label AND `personal_calendar_*` columns are set → use them (personal is the implicit default). Log `calendar_resolution: 'label_default'`.
    - Claude returned `calendar_label = 'work'` but `work_calendar_*` columns are null → return error class `label_unset` with deep-link to settings.
    - Exactly one label is configured (the other is null) AND the configured one isn't the resolution result of branches 1–3 above → fall back to the configured label. Log `calendar_resolution: 'fallback_first_connected'`. Covers two concrete cases: (a) no hint, only Work configured (Personal-default branch can't fire) → write to Work; (b) Claude requested Work but only Personal configured → write to Personal. This is the "only-one-option-exists" fallback, NOT silent multi-choice — when both labels are configured, branches 1–3 always resolve definitively.
    - Both labels null → unreachable here because step 3 already exited.

6. **Provider write.**
    - **Google:** `POST https://www.googleapis.com/calendar/v3/calendars/{id}/events`. Token via Supabase OAuth broker; on `401` from Google, refresh once, retry. On second `401` → error class `oauth_invalid`. On `403` → `permission_denied` (look up calendar's display name from the user's calendar list for the dialog — one extra GET, ~150ms).
    - **Microsoft:** `POST https://graph.microsoft.com/v1.0/me/events` with the same retry/refresh/error matrix.
    - **iCloud:** unreachable from this resolution path — Settings UI only offers Google/Microsoft for label binding.

7. **Build response.**

   Natural-time formatter (locale-aware, optimized for TTS):
    - **Within 7 days:** relative + spelled time. `"i morgen kl. sytten"` / `"tomorrow at five PM"`. Avoid `"17:00"` — Siri pronounces "seventeen-hundred" which sounds wrong.
    - **>7 days out:** absolute, spelled. `"den 15. maj kl. fjorten"` / `"May 15 at two PM"`.

   Dialog template:
    - DA: `"Tilføjet: '{title}', {natural_time} i din {label} kalender."`
    - EN: `"Added: '{title}', {natural_time} in your {label} calendar."`

   Title leads. Snippet `summary`: `"{title} · {kort tid}"`.

   Failure class → deep-link table:

   | Class                  | Deep-link                       | Dialog                                              |
   |------------------------|---------------------------------|-----------------------------------------------------|
   | `unparseable`          | `zolva://chat`                  | "Forstod ikke. Prøv igen i appen."                  |
   | `no_calendar_labels`   | `zolva://settings`              | "Vælg en arbejds- eller privatkalender."            |
   | `label_unset`          | `zolva://settings`              | "Din {label}-kalender er ikke valgt."               |
   | `oauth_invalid`        | `zolva://settings#calendars`    | "Forbind {provider} igen."                          |
   | `permission_denied`    | `zolva://settings`              | "Du har ikke skriverettigheder til {calendar name}." |
   | `provider_5xx`         | `zolva://chat`                  | "{Provider} svarede ikke. Prøv igen."               |

### Logging

Per-call entry in new `widget_action_calls` table (subject to privacy-policy verification — see Privacy section below):

```ts
{
  user_id: uuid,
  action: 'create_event',
  success: bool,
  error_class?: 'unparseable' | 'no_calendar_labels' | 'label_unset' | 'oauth_invalid' | 'permission_denied' | 'provider_5xx',
  calendar_resolution: 'hint_matched' | 'label_default' | 'fallback_first_connected' | 'no_calendar',
  calendar_provider?: 'google' | 'microsoft',
  latency_ms: int,
  claude_tokens: { input: int, output: int },
  claude_model: string,  // e.g. "claude-haiku-4-5-20251001" — track for cost + version diffs
  created_at: timestamptz default now()
}
```

**Never logs raw transcripts or Claude inputs/outputs.**

### Out of scope (Edge Function v2)

No streaming, no multi-turn, no reminder writes, no calendar reads, no Anthropic prompt caching, no prompt-language detection (Claude handles DA+EN uniformly via the system prompt).

---

## Profile + Settings UI

### Migration (normalized columns)

`supabase/migrations/<new-timestamp>_calendar_labels.sql`:

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
   handler for the restore-prompt flow, then cleared. Not read by Edge Functions.';
```

Two label-pairs as concrete columns, check-constrained provider enum, NULL-consistency check. Edge Function reads the four columns directly — no JSONB parse, no defensive shape checks. The transient JSONB snapshot column is only used for the disconnect → reconnect restore prompt; never queried by Edge Functions.

Display name + color are NOT cached in the DB; the Settings picker re-fetches from the provider on open.

### TS types + read/write — `src/lib/calendar-labels.ts`

```ts
export type CalendarLabelKey = 'work' | 'personal';
export type CalendarLabelTarget = {
  provider: 'google' | 'microsoft';
  id: string;
};
export type CalendarLabels = Partial<Record<CalendarLabelKey, CalendarLabelTarget>>;

export async function readCalendarLabels(userId: string): Promise<CalendarLabels>;
export async function setCalendarLabel(
  userId: string,
  key: CalendarLabelKey,
  target: CalendarLabelTarget | null,
): Promise<void>;
```

Read maps the four DB columns → object shape. Write nulls both columns when `target === null`.

### Auto-clear on disconnect (replaces lazy invalidation)

In the existing `disconnect(provider)` handler accessed via `useConnections`:

```ts
async function disconnect(provider: 'google' | 'microsoft') {
  // 1. Snapshot active labels for this provider into previous_calendar_labels
  const labels = await readCalendarLabels(userId);
  const affected = Object.fromEntries(
    Object.entries(labels).filter(([_, v]) => v?.provider === provider),
  );
  if (Object.keys(affected).length > 0) {
    await supabase.from('user_profiles')
      .update({ previous_calendar_labels: affected })
      .eq('user_id', userId);
  }
  // 2. Clear the active label columns for this provider
  for (const [key, target] of Object.entries(labels)) {
    if (target?.provider === provider) {
      await setCalendarLabel(userId, key as CalendarLabelKey, null);
    }
  }
  // 3. Existing OAuth disconnect / token revoke
  // ...
}
```

Lazy invalidation (treating labels as unset only when the provider is gone) was the alternative; rejected because it adds latency to every Siri call (extra token check) and creates ambiguous fallback behavior. Auto-clear-on-disconnect is decisive and the snapshot column preserves user setup for the restore-on-reconnect flow.

### Restore-prompt on same-provider reconnect

After `connect(provider)` succeeds for a provider that has a non-null `previous_calendar_labels` snapshot whose keys point to that provider:

```
┌────────────────────────────────────────────┐
│ Genskab tidligere kalender-valg?           │
│                                            │
│ Vil du bruge "Acme Work" som arbejds-      │
│ kalender til Siri igen?                    │
│                                            │
│         [Nej, vælg ny]      [Genskab]      │
└────────────────────────────────────────────┘
```

On "Genskab": validate the calendar id still exists in the freshly-fetched calendar list (account may have lost access to that calendar), then write to active label columns. Either way, clear `previous_calendar_labels` after the prompt resolves.

If validation fails ("Acme Work" no longer exists in this Google account), show "Den kalender findes ikke længere" and route to the picker.

### Calendar-list helpers — `src/lib/calendar-providers.ts`

```ts
export type ProviderCalendar = {
  provider: 'google' | 'microsoft';
  id: string;
  name: string;
  color: string | null;
  isMainAccount: boolean;
};

export async function listGoogleCalendars(token: string): Promise<ProviderCalendar[]>;
   // GET https://www.googleapis.com/calendar/v3/users/me/calendarList
   // filter: accessRole ∈ {'owner','writer'}
export async function listMicrosoftCalendars(token: string): Promise<ProviderCalendar[]>;
   // GET https://graph.microsoft.com/v1.0/me/calendars
   // filter: canEdit === true
export async function listWritableCalendars(ctx: ChatCtx): Promise<ProviderCalendar[]>;
   // unified call across whichever providers are connected; Promise.allSettled
   // so one provider's failure doesn't blank the picker.
```

Filtering at picker time is best-effort. Org-owner-but-not-calendar-owner edge cases, shared-with-edit-delegation inconsistencies, and Google G Suite policy overrides will get past this filter. Real write-permission failures get surfaced at write time via the `permission_denied` error class.

### Settings UI

New sub-section under existing Connections in `src/screens/SettingsScreen.tsx`:

```
┌────────────────────────────────────────────────┐
│ Stemmestyring (Voice)                          │
│ Når du beder Siri "bed Zolva om at sætte et    │
│ møde", lander mødet i den kalender du vælger   │
│ her. Sig "i min arbejdskalender" for at tilside-│
│ sætte.                                         │
│                                                │
│ Arbejdskalender (Work)         [Ikke valgt >]  │
│ Privatkalender (Personal)      [Ikke valgt >]  │
└────────────────────────────────────────────────┘
```

Picker modal:

```
┌────────────────────────────────────────────────┐
│ Vælg arbejdskalender                [Annullér] │
├────────────────────────────────────────────────┤
│ ⚪ Brug ikke                                   │
│ ─────                                          │
│ GOOGLE — Albert@gmail.com                      │
│ ⚫ Albert@gmail.com                            │
│ ⚪ Acme Work                                   │
│ ⚪ Side Project                                │
│ ─────                                          │
│ MICROSOFT — albert@acme.com                    │
│ ⚪ albert@acme.com                             │
└────────────────────────────────────────────────┘
```

Account email shown in section headers, not as a per-row chip — avoids conflating with Google's own "primary calendar" concept. Selection writes immediately, no save button.

**Empty state — no calendar provider connected:**

```
┌────────────────────────────────────────────────┐
│ Stemmestyring                                  │
│ Forbind Google eller Outlook for at sætte      │
│ møder med Siri.    [Forbind kalender →]        │
└────────────────────────────────────────────────┘
```

Tap link scrolls to the existing connections section above.

### `useCalendarLabels()` hook — `src/lib/hooks.ts`

```ts
export function useCalendarLabels(): {
  labels: CalendarLabels;
  refresh: () => Promise<void>;
  setLabel: (key: CalendarLabelKey, target: CalendarLabelTarget | null) => Promise<void>;
} {
  // TODO(v3): Replace local refresh with Supabase realtime subscription on
  // user_profiles when we add multi-device support (Mac / Watch / Web).
  // For v2 the user is the only writer from one device, so refresh-on-mount
  // + refresh-after-write is sufficient.
  // ...
}
```

### Out of scope (Settings v2)

No multi-account-per-provider account picker (calendars from two Gmails appear flat in the picker, grouped by account email at section header). No bulk import. No labels beyond `work` / `personal`. No realtime sync.

---

## Auth Wire-up

### Entitlement (`app.json`)

```json
"entitlements": {
  "com.apple.security.application-groups": ["group.io.zolva.app"],
  "keychain-access-groups": ["$(AppIdentifierPrefix)io.zolva.shared"]
}
```

`$(AppIdentifierPrefix)` resolves at build time to `<TeamID>.` — for Team `N6WPH3FPFA`, the entitlement becomes `N6WPH3FPFA.io.zolva.shared`. Same target hosts the AppIntent, so no separate target entitlement is needed.

### Shared keychain — `src/lib/keychain.ts`

```ts
import * as SecureStore from 'expo-secure-store';

export const KEYCHAIN_ACCESS_GROUP = 'io.zolva.shared';
export const KEYCHAIN_SERVICE = 'io.zolva.shared';
export const JWT_KEY = 'supabase.access_token';
export const REFRESH_KEY = 'supabase.refresh_token';

const SHARED_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessGroup: KEYCHAIN_ACCESS_GROUP,
  keychainService: KEYCHAIN_SERVICE,
  // SECURITY TRADE-OFF: accessible to any process in this app holding the
  // access-group entitlement after the device has been unlocked at least
  // once since boot. Required so Siri-dispatched AppIntent processes can
  // read the JWT post-reboot before the user has launched Zolva. The
  // alternative WHEN_UNLOCKED would block voice on every device wake.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function writeSharedSession(accessToken: string, refreshToken: string): Promise<void> {
  await SecureStore.setItemAsync(JWT_KEY, accessToken, SHARED_OPTS);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken, SHARED_OPTS);
}

export async function clearSharedSession(): Promise<void> {
  await SecureStore.deleteItemAsync(JWT_KEY, SHARED_OPTS);
  await SecureStore.deleteItemAsync(REFRESH_KEY, SHARED_OPTS);
}
```

Verified at spec time: `expo-secure-store@15.0.8` exposes `keychainService` in `SecureStoreOptions`. No native module fallback needed.

### Auth-state hook in `src/lib/auth.ts`

```ts
supabase.auth.onAuthStateChange((event, session) => {
  // ...existing logic...
  if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
    void writeSharedSession(session.access_token, session.refresh_token);
  }
  if (event === 'SIGNED_OUT') {
    void clearSharedSession();
  }
});
```

Refresh token stored alongside access token specifically so the AppIntent can self-refresh — see below.

### Swift-side reader — `SupabaseSession.swift`

```swift
struct SupabaseSession {
  static let accessGroup = "N6WPH3FPFA.io.zolva.shared"
  static let service = "io.zolva.shared"
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
  // writeKey: SecItemUpdate or SecItemAdd with same query, kSecValueData → Data(token.utf8)
}

enum SupabaseSessionError: Error {
  case notLoggedIn          // tokens missing
  case keychainError(OSStatus)
  case refreshFailed(reason: String)
}
```

### Refresh-from-AppIntent — `SupabaseAuthClient.swift`

The AppIntent must handle expired access tokens. The cached JWT can easily be expired by the time the user invokes Siri (Supabase access tokens are typically 1h; the user might not open the app for a day). Without refresh, voice fails every morning for most users. v2 must-have.

Strategy: **retry-on-401**. The `IntentActionClient` posts with the cached access token. On 401, call `SupabaseAuthClient.refresh(refreshToken)`, write the new access token back to keychain, and retry the post once.

```swift
struct SupabaseAuthClient {
  static let projectRef = "sjkhfkatmeqtsrysixop"
  // Public-safe anon (publishable) key. Read at runtime from
  // Bundle.main.object(forInfoDictionaryKey: "SupabaseAnonKey") so the
  // value lives in app.json's expo.ios.infoPlist (already the v1 pattern
  // for non-secret runtime config). Plan task: add the infoPlist key
  // before SupabaseAuthClient.swift compiles.
  static let anonKey: String = {
    guard let key = Bundle.main.object(forInfoDictionaryKey: "SupabaseAnonKey") as? String,
          !key.isEmpty else {
      fatalError("SupabaseAnonKey missing from Info.plist — see app.json expo.ios.infoPlist")
    }
    return key
  }()

  static func refresh(refreshToken: String) async throws -> String {
    var req = URLRequest(url: URL(string:
      "https://\(projectRef).supabase.co/auth/v1/token?grant_type=refresh_token")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(anonKey, forHTTPHeaderField: "apikey")
    req.httpBody = try JSONEncoder().encode(["refresh_token": refreshToken])

    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw SupabaseSessionError.refreshFailed(
        reason: "HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
    }
    let body = try JSONDecoder().decode(RefreshResponse.self, from: data)
    try SupabaseSession.writeAccessToken(body.access_token)
    if let newRefresh = body.refresh_token {
      try SupabaseSession.writeRefreshToken(newRefresh)  // Supabase rotates refresh tokens
    }
    return body.access_token
  }

  private struct RefreshResponse: Decodable {
    let access_token: String
    let refresh_token: String?
  }
}
```

`IntentActionClient` retry logic:

```swift
struct IntentActionClient {
  static func send(prompt: String, timezone: String) async throws -> WidgetActionResponse {
    let accessToken = try SupabaseSession.readAccessToken()
    do {
      return try await postOnce(prompt: prompt, timezone: timezone, jwt: accessToken)
    } catch IntentActionError.unauthorized {
      let refreshToken = try SupabaseSession.readRefreshToken()
      let newAccessToken = try await SupabaseAuthClient.refresh(refreshToken: refreshToken)
      return try await postOnce(prompt: prompt, timezone: timezone, jwt: newAccessToken)
    }
  }
  // postOnce: 6s timeout, throws .unauthorized on 401, .recoverable on other failures
}
```

### Failure cases — three distinct code paths

1. **Both tokens missing** (`SupabaseSession.readAccessToken()` throws `.notLoggedIn`) → AppIntent surfaces "Du er logget ud — åbn Zolva" with `zolva://settings` deep-link. No network call.
2. **Access token present but expired, refresh token present** → first post fails with 401, refresh succeeds, second post succeeds. User sees a successful response (with ~500-1500ms extra latency for the refresh round-trip).
3. **Access token rejected, refresh token also rejected** (revoked from another device, or refresh token also expired) → refresh call throws `.refreshFailed`, AppIntent surfaces same "logget ud" dialog. Distinct test path from case 1.

---

## Test Plan

### SPIKE FIRST — Keychain access verification

Before any other v2 work, ship a minimal AppIntent to TestFlight that does nothing except attempt `SecItemCopyMatching` with the configured access group and service, then logs the `OSStatus`. Real-device Hey-Siri invocation. Two outcomes:

1. `OSStatus == errSecSuccess` → access group + service + entitlement config correct, proceed with full v2 build.
2. Any other status → fix the entitlement / access-group / service config before writing more code.

Throwaway code on a feature branch; merge, ship, verify, revert and continue. Intentionally a separate ship so we don't pile a half-finished snippet view, Edge Function, label settings on top of an unverified Keychain assumption.

### iOS — SwiftUI previews

```swift
#Preview("Snippet success") {
  AskZolvaSnippetView(state: .success(
    summary: "Møde med Sophie · i morgen kl. 17",
    deepLink: URL(string: "zolva://calendar/event/abc123")!
  ))
}
#Preview("Snippet error — recoverable") { /* ... */ }
#Preview("Snippet error — auth (logged out)") { /* ... */ }
#Preview("Snippet error — permission") { /* ... */ }
#Preview("Stone happy") { Stone(mood: .happy).frame(width: 56, height: 56) }
#Preview("Stone worried") { Stone(mood: .worried).frame(width: 56, height: 56) }
```

Each state previewed in light + dark mode. No assertion, eyeballed in canvas — same pattern as v1.

### iOS — AppIntent unit tests (`AskZolvaIntentTests.swift`)

- Happy path with mocked `IntentActionClient` → success state with deep-link.
- `SupabaseSession.readAccessToken()` throws `.notLoggedIn` (no tokens at all) → auth-error dialog, never calls network.
- `IntentActionClient.send()` returns 401 with valid refresh token → refresh succeeds → retry succeeds → success state. Verify `SupabaseAuthClient.refresh()` called exactly once.
- `IntentActionClient.send()` returns 401 with refresh token also rejected → auth-error dialog, settings deep-link.
- `IntentActionClient.send()` returns 401, refresh token MISSING from keychain (distinct from rejected) → auth-error dialog. Different code path than tokens-rejected.
- `IntentActionClient.send()` times out after 6s → recoverable error.
- Malformed response → recoverable error, no crash.

### Edge Function — Deno tests (`supabase/functions/widget-action/index.test.ts`)

- JWT verification: valid token, invalid signature, expired (`exp` past), missing `kid`, `kid` not in JWKS, missing Authorization header → expected status codes for each.
- Empty prompt guard → correct worried response.
- Calendar resolution algorithm — every branch:
   - hint matched + label exists → uses labeled id, logs `hint_matched`
   - no hint, default label exists → uses default, logs `label_default`
   - hint requested but label unset → returns `label_unset`
   - both labels null → returns `no_calendar_labels`
   - single label configured, Claude requests the unconfigured one → falls back, logs `fallback_first_connected`
- Claude tool-use parsing: stubbed model output → expected calendar resolution + provider write call.
- Provider write outcomes — Google and Microsoft each:
   - 200 → success response
   - 401 → token refresh attempted, retry, success or `oauth_invalid`
   - 403 → `permission_denied` with calendar name lookup
   - 5xx → `provider_5xx`
- Server-side `end` default applied when Claude omits.
- Timezone passed through to Claude system prompt verbatim.

Stubbed Anthropic calls in unit tests; real Anthropic only in integration suite.

### Manual on-device QA

`docs/superpowers/plans/widget-v2-qa-checklist.md`. Real iPhone, not simulator (Keychain access groups differ in sim). Both Danish and English iOS locale required.

```markdown
## Setup
- [ ] Fresh login as albertfeldt1@gmail.com on device
- [ ] Connect Google calendar
- [ ] Connect Microsoft calendar
- [ ] Settings → Stemmestyring → pick a Google calendar as Work
- [ ] Settings → Stemmestyring → pick a Microsoft calendar as Personal

## Voice trigger paths
- [ ] "Hey Siri, bed Zolva om at sætte et møde i morgen kl. 17"
- [ ] "Hey Siri, ask Zolva to set a meeting tomorrow at 5 PM"
- [ ] Action Button bound to "Spørg Zolva" — press, then speak
- [ ] Bare "Hey Siri, spørg Zolva" — Apple's voice prompt asks 
       "Hvad skulle jeg spørge om?", user speaks, full transcript ships
- [ ] Same in English: "Hey Siri, ask Zolva" → "What should I ask?" → speak → success

## Routing
- [ ] No calendar hint → lands in Personal (default label)
- [ ] "i min arbejdskalender" → lands in Work
- [ ] "in my work calendar" → lands in Work
- [ ] Misspelled hint ("im my workkalender") → Claude either matches or 
       falls back to default; verify dialog says which calendar was used

## Response surface
- [ ] Success: Stone happy + summary line + spoken confirmation
- [ ] Time format: "i morgen kl. sytten" (DA) / "tomorrow at five PM" (EN); 
       NEVER "17:00" / "1700" / ISO timestamp in spoken response
- [ ] Visible snippet matches spoken response
- [ ] Tap success snippet → opens calendar tab on the right day at the new event

## Failure paths
- [ ] Disconnect from internet → "Forbindelse fejlede. Prøv igen."
- [ ] Manually clear access token from shared keychain (dev tool), keep 
       refresh token → voice call → refresh path fires, success (with 
       slight latency increase, no user-visible failure)
- [ ] Manually clear BOTH tokens → voice call → "Du er logget ud" + 
       deep-link to settings
- [ ] Sign out from another device (refresh token revoked server-side) → 
       voice call → refresh fails with 401 → "Du er logget ud" 
       (distinct from tokens-missing code path)
- [ ] Pick a Google calendar with read-only access → write fails with 
       `permission_denied` dialog naming that calendar
- [ ] Speak gibberish → `unparseable` dialog routes to chat
- [ ] No calendar labels set → routes to Settings with the "vælg" copy

## Auth state matrix
- [ ] Fresh login → first voice call works (cached access token still valid)
- [ ] Fresh login → wait 65 minutes → voice call → AppIntent silently 
       refreshes; user sees success, dialog spoken without delay >2s extra

## Disconnect / reconnect flow
- [ ] Disconnect Google → snapshot taken; Work label cleared in Settings UI
- [ ] Reconnect same Google account → "Genskab tidligere kalender-valg?" 
       prompt → tap "Genskab" → Work label restored
- [ ] Disconnect Google, then reconnect a DIFFERENT Google account → 
       restore prompt either auto-skips (calendar id not found) or shows 
       "Den kalender findes ikke længere"; never silently mis-routes

## Latency
- [ ] Hey Siri → spoken response: target ≤6s on cold Edge Function, p95 ≤4s warm
- [ ] If Siri shows the "thinking..." spinner for >8s, that's a fail — 
       Edge Function is too slow; profile and fix server-side, NOT extend 
       the AppIntent client timeout

## Privacy spot-check
- [ ] After 5 voice calls, query widget_action_calls (if logging is in DB 
       per privacy verdict) → no row contains the raw transcript or any 
       free-form prompt text. Logged fields exactly match the schema.
```

### Latency profiling

Run before TestFlight ship:
- **Cold-start:** 5 isolated calls (kill Edge Function instance between each by waiting 15+ min). Report `max`. Target: cold ≤6s.
- **Warm:** **20+ back-to-back calls.** Report p50 and p95. Target: p50 ≤2.5s, p95 ≤4s.
- If p95 misses, profile per-step (Claude vs DB vs provider write); fix server-side. Don't extend the Swift client timeout.

---

## Privacy / DPA

**Verify the policy before deploying the Edge Function.**

**Where to look:** Zolva's privacy policy — likely at `https://app.zolva.io/privacy` or in `docs/legal/` in this repo (not yet confirmed at spec time). **Owner of confirmation: Albert.**

**What to look for:** does the policy commit to a specific log retention period or to a "no logs" stance?

- **Policy says X days (e.g. 30, 60, 90):** create the `widget_action_calls` table with that retention. Add a daily purge job (mirror the held-back `supabase/schedule-icloud-proxy-retention.sql.template` pattern). 60 days is a reasonable starting proposal, matching the existing iCloud-proxy pattern.
- **Policy says "no logs at all" or "anonymous metrics only":** **don't** create a DB table. Use ephemeral structured logging instead — `console.log(JSON.stringify({ ... }))` from the Edge Function, picked up by Supabase function logs (typically retained ~7 days by Supabase platform itself, not by us). Same fields as the schema, but ephemeral. We lose long-tail debuggability but stay policy-compliant.

**What to look for beyond retention:** the current policy may not mention voice/Siri data flow, Anthropic processing, or the new Edge Function pathway. Update the policy text if needed before TestFlight — voice transcripts being processed by Anthropic are potentially new disclosures depending on what the existing policy already covers.

---

## Future Work (post v2)

- **Reminder voice path** — requires moving Zolva reminders from client AsyncStorage to a server-side Supabase table first. Separate scoped piece of work that benefits future Mac/Web/Watch surfaces too.
- **Update / delete event via voice** — the awkward case (need to find the right event first); naturally an in-app gesture.
- **Multi-account-per-provider account picker** — if the user connects two Gmail accounts, Settings could group calendars by account. v2 shows them flat under per-account section headers.
- **Bulk import of "all my work calendars"** — one label → multiple ids, fan-out write logic.
- **Per-event-type labels beyond `work` / `personal`** — `family`, `side-project`, etc. Supported by the JSONB-snapshot column shape but not yet exposed in UI.
- **Realtime sync** — when adding multi-device support (Mac / Watch / Web), `useCalendarLabels` switches to a Supabase realtime subscription on `user_profiles`. Marked with TODO in v2.
- **Local exp-based JWT expiry pre-check in the AppIntent** — small latency optimization (skip the failed first request) for ~15 lines of Swift; not worth the complexity in v2 with retry-on-401 already in place.
- **Custom Siri snippet for `permission_denied` failures showing the conflicting calendar name as a chip** — small visual polish.
- **End-time heuristics** ("lunch" → 45min, "1:1" → 30min) instead of the fixed 60-minute server default.

---

## References

- **Predecessor spec:** `docs/superpowers/specs/2026-04-27-widgets-design.md`
- **v1 widget bridge** (mirror pattern for `withVoiceIntents.js`): `plugins/widget-bridge/withWidgetBridge.js`
- **Existing Settings connections section:** `src/screens/SettingsScreen.tsx` (uses `useConnections`, `connect` / `disconnect`)
- **Existing chat-tools surface** (port reference for Edge Function calendar write): `src/lib/chat-tools.ts` — specifically `createCalendarEvent`
- **OAuth broker memory:** Supabase brokers Google/Microsoft tokens; provider secrets in Supabase dashboard
- **Existing iCloud-proxy retention pattern** (template for purge job): `supabase/migrations/20260427130000_icloud_proxy_calls_retention.sql` (held-back)
