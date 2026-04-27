# iOS Homescreen Widget — Design

**Date:** 2026-04-27
**Branch:** TBD (suggested: `feature/widget-medium`)
**Status:** Approved via brainstorm, ready for implementation plan.
**Depends on:** Existing daily-brief edge function and `briefs` table; existing `useCalendarItems` hook; Expo SDK 53+ with config-plugin support.

## Goal

Ship a single medium-size iOS homescreen widget that gives users a glanceable contextual nudge plus a one-tap path into Zolva chat. The widget is read-only and adapts what it shows to the user's day:

- **Morning** — headline of today's morning brief.
- **Around any meeting** — countdown nudge ("Du har et møde om Q2-budget om 25 minutter") and during-meeting state.
- **Evening** — headline of evening recap.
- **Otherwise** — "Næste: [next event]" or, if nothing applies, prominent "Spørg Zolva..." chat affordance.

A persistent **"Spørg Zolva…"** chat row sits at the bottom regardless of state, so any tap on the widget either opens the relevant context (brief modal, calendar event) or jumps straight into chat with the input focused.

iOS-first; Android (AppWidget RemoteViews) is a follow-up once the iOS surface has user feedback.

## User-facing shape

- After a TestFlight build with the widget target, the user adds **Zolva** from the iOS widget gallery → picks the medium size → drops it on the homescreen.
- The widget shows context appropriate to the current moment, refreshing automatically as the day progresses.
- Tap targets:
  - Upper context block → deep-link into the relevant Zolva surface (`zolva://today` for brief, `zolva://calendar/event/<id>` for meeting nudge, `zolva://today` for evening recap).
  - Lower chat row → `zolva://chat?focus=1`, opening Zolva straight to the chat tab with the keyboard up.
- If the snapshot is missing (first install, app never opened) or older than 24 hours, the widget shows a stripped-down "Åbn Zolva for at opdatere" + the chat row.

## Architecture

A new native iOS WidgetKit extension lives alongside the existing `ZolvaApp.app`, wired up via an Expo config plugin so `eas build` continues to produce a complete ipa without manual Xcode steps. The widget is a dumb display — all data fetching happens in the RN app, which writes a JSON snapshot to a shared App Group container that the widget reads on each timeline tick.

### Components

```
┌──────────────────────────────────────┐
│  RN app (existing)                   │
│  ─ useCalendarItems / brief hooks    │  data already fetched
│  ─ src/lib/widget-bridge.ts (new)    │  writes snapshot, triggers reload
└────────────┬─────────────────────────┘
             │ writes JSON
             ▼
   ┌──────────────────────────┐
   │  App Group container     │  group.io.zolva.app/widget-snapshot.json
   │  (shared, on-device)     │
   └────────────┬─────────────┘
                │ reads JSON
                ▼
┌──────────────────────────────────────┐
│  ZolvaWidget.appex (new iOS target)  │
│  ─ ZolvaWidgetBundle.swift           │  @main, registers widget kind
│  ─ SnapshotProvider.swift            │  TimelineProvider, reads JSON
│  ─ SnapshotPayload.swift             │  Codable struct, schema-versioned
│  ─ MediumWidgetView.swift            │  SwiftUI, branches by state
└──────────────────────────────────────┘
```

### Files added

- `plugins/widget-target.js` — Expo config plugin: declares the widget target, App Group entitlement, required Info.plist keys.
- `ios/ZolvaWidget/ZolvaWidgetBundle.swift`, `SnapshotProvider.swift`, `SnapshotPayload.swift`, `MediumWidgetView.swift` — the widget extension target.
- `ios/ZolvaWidget/Info.plist`, `ZolvaWidget.entitlements` — extension manifest + App Group declaration.
- `src/lib/widget-bridge.ts` — RN-side TS module: `writeSnapshot()`, `buildSnapshotFromState()`, `triggerWidgetReload()`. iOS-only; Android paths are no-ops for now.

### Files modified

- `app.json` — register the config plugin, add the App Group to iOS entitlements, bump iOS `buildNumber`.
- `App.tsx` — call `writeSnapshot` on app foreground (via the existing `AppState.addEventListener('change')` hook) and after `useDailyBrief` delivers a fresh brief.
- `src/lib/hooks.ts` — `useCalendarItems` calls `writeSnapshot` after a successful fetch settles its merged event list.

### Dependencies

- `expo-apple-targets` (or the slimmer `react-native-widget-extension`) — supplies the config-plugin scaffolding for adding extension targets without ejecting from Expo prebuild. Final pick determined during implementation; both follow the same architectural pattern, so this isn't a load-bearing decision.
- No new server-side dependencies for Approach 1.

## Data flow

### Write triggers (RN app → snapshot)

1. **App foreground.** Every transition to `'active'` debounced at 5 seconds — handles natural app-switching cycles.
2. **After morning/evening brief delivery.** The `useDailyBrief` hook (or the `'brief'` push notification handler) writes once a brief lands so the widget surfaces the headline within seconds.
3. **After a successful calendar fetch.** `useCalendarItems` writes after its `Promise.allSettled` resolves with at least one provider's events.
4. **After memory consent / first connect.** Initial snapshot is written when the user first has data, so the widget isn't stuck on placeholder.

Each write call:
1. Builds a fresh `SnapshotPayload` from in-memory app state via `buildSnapshotFromState`.
2. Serializes to JSON and writes to `<AppGroupContainer>/widget-snapshot.json`.
3. Calls native `WidgetCenter.shared.reloadAllTimelines()`.

### Read flow (widget → display)

`SnapshotProvider.getTimeline(in:completion:)`:

1. Reads `widget-snapshot.json` from the App Group container.
2. Decodes via `JSONDecoder` into `SnapshotPayload`. Decode failure → returns a single placeholder entry, the widget shows the stale-snapshot fallback.
3. Constructs entries at each meaningful boundary in the rest of today:
   - `now`
   - For each upcoming event: `event.start - 30min` (nudge begins), `event.start` (during-meeting), `event.end + 1min`.
   - 17:00 local (evening transition).
   - Tomorrow 06:00 (forces a fresh snapshot read for the morning brief).
4. Returns `.atEnd` policy. iOS reschedules the next `getTimeline` call after the last entry.

### Display logic per state

`MediumWidgetView` is a pure function of `(payload, currentDate)`:

- **Brief.** `06:00 ≤ now < 10:00` AND `payload.morningBrief != nil` → headline + Stone glyph + chat row.
- **Meeting nudge.** Any event in `payload.todayEvents` where `event.start - 30min ≤ now ≤ event.end` → "Du har et møde om {title} om {Text(event.start, style: .relative)}" + chat row. iOS auto-updates the relative time without us reloading.
- **Evening recap.** `now ≥ 17:00` AND `payload.eveningBrief != nil` → evening headline + chat row.
- **Otherwise.** "Næste: {nextEventTitle} {Text(nextStart, style: .relative)}" if any future event remains today; else `Spørg Zolva...` rendered prominent on the upper block + chat row below.
- **Stale snapshot guard.** `now - payload.generatedAt > 24h` → "Åbn Zolva for at opdatere" + chat row.

### Data contract

```ts
{
  schema: 1,                        // bump when payload shape changes meaning
  generatedAt: ISO8601,             // app-side write timestamp
  morningBrief: { headline: string } | null,
  eveningBrief: { headline: string } | null,
  todayEvents: Array<{
    id: string,                      // for deep-link tap → event detail
    start: ISO8601,
    end: ISO8601,
    title: string,
  }>,
  // Empty string falls back to default "Spørg Zolva..."
  chatPrompt: string,
}
```

The matching `SnapshotPayload` Codable struct on the Swift side is the single source of truth for the wire format on its end. Schema is versioned because the payload will evolve (lock-screen complications, small/large size variants, more states).

## Error handling

- **No snapshot file.** First widget render returns a placeholder entry; the user sees "Åbn Zolva for at opdatere" + chat row. Resolves on first app foreground.
- **Corrupt JSON / decode failure.** Caught, logged via `os_log`, falls through to the placeholder. Same UX as no snapshot.
- **Schema mismatch.** Treated identically to decode failure — explicit fallback path keeps a future widget version safe against an old app's snapshot and vice versa.
- **Stale snapshot (>24h old).** Renders the dedicated stale state instead of yesterday's content.
- **User signed out / demo mode.** App writes an empty snapshot (briefs null, events empty); widget falls through to the chat-row state. No leak to a different user even if the device is handed off.
- **Missing App Group entitlement.** Caught at build time by the config plugin's verification step. CI sanity check ensures `app.json` and the iOS entitlements file agree on the App Group ID.
- **Privacy / iCloud Backup.** App Group containers are included in iCloud Backup by default. Snapshot only contains data the user explicitly connected (calendar event titles, brief headlines) — same surface the app already shows. Documented; not a blocker for v1.
- **Time zone / DST.** Display uses `Text(date, style: .relative)` for countdowns (locale-aware). Snapshot writes ISO8601 with offset; widget converts via the device's calendar.

## Testing

- **Unit (TypeScript / Jest).** `buildSnapshotFromState` is a pure function — feed mocked briefs/events and assert payload shape across the matrix: morning brief only, evening only, both null, empty events, events that span DST, events ending earlier today vs later today.
- **SwiftUI previews.** Every render state has an explicit preview in `MediumWidgetView.swift` (placeholder, stale, brief, meeting-30min-out, meeting-now, evening, chat-only). Visible in Xcode preview canvas.
- **Snapshot tests.** `swift-snapshot-testing` captures golden images of each preview state, run on CI to catch unintentional layout regressions.
- **Manual walkthrough on dev build.** Single test plan documented in the implementation plan: open app to seed snapshot → background → install widget → walk through 3 timeline boundaries (or use the simulator's "Trigger Background Refresh"). Captured as a checklist alongside other manual QA.
- **No native unit test for `WidgetCenter.reloadAllTimelines()`** — Apple framework call, trusted to work.

## Migration plan to Approach 2 (server-driven payload)

Approach 1 ships first because the widget is read-only and the snapshot writer is a thin RN module. Once it's stable, the next step is reducing the "I just woke my phone, the widget is from this morning" gap by letting the widget pull fresh data from a server endpoint without waiting on the app being foregrounded.

Migration path:

1. Add a new edge function `/widget-snapshot` that builds the same `SnapshotPayload` server-side (briefs from `briefs` table; events fetched via the existing calendar adapters).
2. Pass the user's JWT from the app to the widget once at sign-in (write to App Group). Refresh on token rotation.
3. `SnapshotProvider` learns to call `/widget-snapshot` on each `getTimeline` cycle if the local snapshot is older than N minutes; fall back to the local file on network failure.
4. Bump `schema` to v2 if the payload gains fields.
5. Keep the App Group write path as a warm-cache so the widget stays useful offline.

The data contract, SwiftUI views, timeline logic, and error handling all stay the same — Approach 2 only changes where `SnapshotPayload` comes from. Designing v1 against the JSON contract (rather than a tightly-coupled in-memory representation) is what makes this clean.

## Out of scope for v1 (deferred)

- Small / large widget sizes.
- Lock screen complications (`accessoryRectangular`, `accessoryCircular`, etc.).
- Live Activities.
- Android AppWidget — same JSON contract will work; native rendering is a separate ticket.
- Voice-first quick-add via Siri AppIntents.
- Server-driven payload (Approach 2) — see migration plan above.
- User-configurable widget content (e.g., choose to show only events). YAGNI for v1.

## Success criteria

- Medium widget installable from the iOS widget gallery on a TestFlight build.
- Each of the seven render states (placeholder, stale, brief, meeting-30min, meeting-now, evening, chat-only) is visible in SwiftUI preview canvas and verified manually on device.
- Widget refreshes on app foreground, after brief delivery, after calendar fetch, and at each timeline boundary without manual intervention.
- Both tap targets (context block, chat row) deep-link into the correct app surface.
- Snapshot writes are debounced and don't trigger more than once per 5 seconds in normal use.
- No PII beyond what the app already shows on the user's homescreen leaves the device.
