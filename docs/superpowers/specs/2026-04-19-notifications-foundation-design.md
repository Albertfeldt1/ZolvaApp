# Notifications — Foundation + Local Scheduled (Sub-project 1)

**Date:** 2026-04-19
**Status:** Draft — awaiting user review
**Scope:** Sub-project 1 of a three-part notifications roadmap.

## Roadmap context

Notifications split into three independent sub-projects:

1. **Foundation + Local Scheduled** (this spec) — permissions, settings, local scheduling for reminders, daily digest, calendar pre-alerts.
2. **In-App Notification Center** — bell icon feed, unread badges.
3. **Server Push for New Emails** — Expo push tokens, backend watcher (Gmail/Graph), edge function.

Each sub-project gets its own spec → plan → implementation. This document covers sub-project 1 only.

## Goals

A user can:

- Receive a local notification when a reminder with a due time comes due.
- Receive a one-line daily digest at 8am local time.
- Receive a 15-minute pre-alert before accepted calendar meetings with other attendees.
- Toggle each of the three types independently in Settings.
- Tap any notification and land on the screen most relevant to it.

Non-goals (reserved for later sub-projects):

- Push notifications from a server.
- In-app notification center UI / bell feed / unread badges.
- User-configurable digest time or pre-alert lead time.

## Key product decisions

| Decision | Choice |
|---|---|
| Trigger types | Reminders + daily digest + calendar pre-alerts |
| User controls | Per-type toggles in Settings; no other knobs in v1 |
| Reminder with no `dueAt` | No notification — lives only in the in-app list |
| Tap behavior | Deep-link per type (reminder → TodayScreen, digest → TodayScreen, pre-alert → CalendarScreen) |
| Permission timing | Just-in-time — on first enable of a toggle, or on first reminder with a dueAt |
| Digest content | One-line headline (counts), not a summary |
| Calendar pre-alert scope | Events with other attendees AND user has accepted |
| Calendar sync | Reconcile on app foreground (AppState → active) |
| Reminder marked done/deleted | Pending notification is cancelled |
| Foreground behavior | In-app banner while app is active; no system notification |

## Architecture

**Approach:** Centralized `notifications.ts` module. All `expo-notifications` imports and OS calls live in that one file. Callers (reminders, calendar sync, digest) talk only to the typed API. Settings are persisted in a parallel `notification-settings.ts` store that mirrors the subscribe/hydrate pattern of `memory-store.ts`.

**Why centralized:** A single source of truth for permissions, identifier conventions, and deep-link routing. Adding a fourth notification type in the future (or swapping in server push in sub-project 3) is a one-file change.

### Files

**New:**

- `src/lib/notifications.ts` — permission handling, schedule/cancel, identifier scheme, response handler registration.
- `src/lib/notification-settings.ts` — AsyncStorage-backed prefs (`reminders`, `digest`, `preAlerts` booleans), subscribe pattern like `memory-store.ts`.
- `src/lib/calendar-events-today.ts` — small helper that fetches today's events from connected Google/Microsoft calendars and normalizes them (attendees, response status, start time). Isolates calendar fetch from notification logic so the notifications module stays OS-only.

**Modified:**

- `src/lib/memory-store.ts` — `addReminder` and `markReminderDone` and `removeReminder` call `scheduleReminderNotification` / `cancelReminderNotification`. Also change `Reminder.dueAt` in `src/lib/types.ts` from `Date` to `Date | null` and remove the 1-hour default in `addReminder` (see Type changes below).
- `src/lib/types.ts` — `Reminder.dueAt: Date | null`.
- `App.tsx` — register notification response handler once at mount; add `AppState` listener that calls `syncOnAppForeground()` when state transitions to `active`.
- `src/screens/SettingsScreen.tsx` — three toggle rows (Reminders, Daily Digest, Calendar Pre-alerts); each enable call goes through `ensurePermission()` and persists to `notification-settings`.
- `app.json` — add `expo-notifications` plugin with iOS permission string and Android default channel.
- `package.json` — add `expo-notifications`.

### `notifications.ts` API

```ts
type PermissionStatus = 'granted' | 'denied' | 'undetermined';

type NotificationPayload =
  | { type: 'reminder'; reminderId: string }
  | { type: 'digest'; date: string }
  | { type: 'calendarPreAlert'; eventId: string };

// Permissions
ensurePermission(): Promise<PermissionStatus>;
getPermissionStatus(): Promise<PermissionStatus>;

// Reminders
scheduleReminderNotification(reminder: Reminder): Promise<void>;
  // No-op if dueAt is null, dueAt is in the past, or reminders toggle is off.
cancelReminderNotification(reminderId: string): Promise<void>;

// Calendar pre-alerts — reconciliation, not incremental
syncCalendarPreAlerts(events: CalendarEventForAlert[]): Promise<void>;
  // Cancels all calendar:* notifications, then reschedules for each event
  // that matches the filter (has other attendees, user accepted, 15 min out).

// Daily digest — idempotent
syncDailyDigest(): Promise<void>;
  // Ensures exactly one digest:<YYYY-MM-DD> is scheduled for the next 8am local.
  // If today's digest has already fired, schedules tomorrow's.

// App-level coordinator — called on AppState -> active
syncOnAppForeground(): Promise<void>;
  // Internally: syncDailyDigest() + calendar-events-today fetch + syncCalendarPreAlerts().

// Tap routing
registerResponseHandler(onTap: (payload: NotificationPayload) => void): () => void;
```

### Identifier convention

Every OS-scheduled notification gets a deterministic identifier so we can cancel/replace without bookkeeping:

- `reminder:<reminderId>`
- `calendar:<eventId>`
- `digest:<YYYY-MM-DD>`

Reconciliation for calendar uses "cancel all `calendar:*`, then reschedule" — simpler than diffing and correct because the cost of scheduling N (~10) local notifications is negligible.

### Settings gate

Every scheduling function in `notifications.ts` reads `notification-settings` and no-ops if the relevant toggle is off. This centralizes the gate rather than forcing every caller to check. Toggling a type off does not cancel existing notifications immediately; they cancel on the next sync cycle or get dropped because the scheduling path no-ops. For reminders, the cancel path still works regardless of toggle state.

## Data flow

### Reminder creation (happy path)

1. User (or Claude via tool use) calls `addReminder(text, dueAt)`.
2. `memory-store.ts` persists the reminder.
3. `memory-store.ts` calls `scheduleReminderNotification(reminder)`.
4. `notifications.ts` checks the `reminders` toggle and `dueAt` validity; if both pass, calls `ensurePermission()`.
5. If permission `granted`, schedule an OS notification with identifier `reminder:<id>` firing at `dueAt`.
6. If `denied`, no-op (UI banner offers a path to system Settings — see Error handling).

### App foreground (AppState → active)

1. `App.tsx` listener calls `syncOnAppForeground()`.
2. `syncDailyDigest()` runs first — checks if a `digest:<next-date>` notification exists; if not, schedules it for 8am.
3. Calendar fetch helper pulls today's events from connected Google/Microsoft calendars.
4. `syncCalendarPreAlerts(events)` cancels all `calendar:*` identifiers, then iterates events: for each event with other attendees, user accepted, and start time > now + 15 min, schedule `calendar:<id>` for `start - 15 min`.

### Tap / deep link

1. User taps a notification.
2. OS delivers the `NotificationResponse` to the handler registered in `App.tsx` via `registerResponseHandler`.
3. Handler switches on `payload.type` and navigates:
   - `reminder` → TodayScreen
   - `digest` → TodayScreen
   - `calendarPreAlert` → CalendarScreen

Navigation integration: this app uses screen state rather than a nav library (per `App.tsx` conventions). The response handler sets the active screen via the same mechanism the tab bar uses. Details resolved during implementation.

### Foreground banner

`Notifications.setNotificationHandler` returns a per-notification decision. When the app is foregrounded, return `{ shouldShowBanner: true, shouldPlaySound: false, shouldSetBadge: false }` so iOS shows a banner rather than silently stashing the notification.

## Type changes

`Reminder.dueAt: Date` → `Date | null`.

Current `addReminder` defaults missing `dueAt` to "1 hour from now" (`memory-store.ts:139`). That contradicts the Q3 decision (no `dueAt` → no notification). Remove the default; store `null` when caller omits `dueAt`. UI code that reads `dueAt` (TodayScreen, etc.) must handle `null` — render without a time, or group under an "undated" section. Consumers to audit during implementation: anything reading `reminder.dueAt`.

## Error handling

| Scenario | Behavior |
|---|---|
| Permission undetermined on first schedule | Prompt once via `ensurePermission()`; if denied, no-op this schedule call, show a Settings-linked banner on next attempt |
| Permission denied | All `schedule*` calls no-op silently; Settings screen shows a persistent "Notifications disabled in system Settings" banner above the toggles with a button to open iOS Settings |
| `dueAt` in the past | No-op (don't schedule a notification for the past) |
| User toggles a type off | Next sync cycle won't schedule new ones; existing ones stay until they fire or are cancelled individually (reminders cancel on done/delete; calendar cancels on next foreground sync; digest expires) |
| Calendar fetch fails on foreground | Skip `syncCalendarPreAlerts()` for this cycle; keep whatever was scheduled; log in `__DEV__` |
| Device rejects scheduling (rare) | Swallow and `console.warn` in `__DEV__`; do not surface to user — notifications are best-effort |
| Reminder `dueAt` edited | Caller should `cancelReminderNotification(id)` then `scheduleReminderNotification(updated)` — document in the API |

## Testing strategy

No unit test framework is currently installed in this project. Testing for this sub-project is manual against a dev build (not Expo Go — per memory, Expo Go has notification limits). Checklist:

**Permission flow**
- First toggle enable on iOS shows the system prompt.
- Denying the prompt leaves the toggle visually off; re-enabling surfaces the Settings-linked banner.
- Granting the prompt persists; app restart keeps permission granted and toggle on.

**Reminders**
- Create a reminder with `dueAt` = now + 30 seconds; lock device; notification fires.
- Mark a pending reminder done; the scheduled notification does not fire.
- Create a reminder without `dueAt`; no notification is scheduled; reminder appears in list.
- Tap a reminder notification; app opens to TodayScreen.

**Daily digest**
- Foreground app after 8am; digest for tomorrow is scheduled, not today's (already past).
- Foreground app before 8am; digest for today is scheduled.
- Disable digest toggle; foreground; no digest scheduled.

**Calendar pre-alerts**
- Accept a Google Calendar event with attendees starting in 45 min; foreground app; pre-alert scheduled.
- Decline the event; foreground; pre-alert is cancelled.
- Move the event 30 min later in Google Calendar; foreground app; pre-alert reschedules.
- Create a solo (no attendees) event; foreground; no pre-alert.

**Foreground behavior**
- Fire a notification while the app is active; banner appears, no system notification.

## Open implementation details (not design)

These are deferred to the implementation plan:

- Exact navigation mechanism for deep-link (setting active tab index vs. a routing effect).
- Whether `notification-settings` writes are debounced.
- Android notification channel naming and defaults.
- Whether `calendar-events-today.ts` is a new file or grafted onto existing `google-calendar.ts` / `microsoft-graph.ts`.
