# Notifications — In-App Notification Center (Sub-project 2)

**Date:** 2026-04-19
**Status:** Approved (user said "just do it")
**Scope:** Sub-project 2 of the three-part notifications roadmap.

## Roadmap context

Sub-project 1 (foundation + local scheduled) shipped: reminders, daily digest, calendar pre-alerts, per-type toggles, tap→tab routing. This sub-project adds an in-app feed so users can see a history of notifications and app activity with an unread badge on the Today bell. Sub-project 3 (server push for new emails) is unaffected.

## Goals

A user can:

- Open a feed from the bell icon on TodayScreen that lists past notifications and notable app events.
- See an unread badge on the bell when new items arrive.
- Tap a feed row to mark it read and deep-link to the relevant tab.
- Mark everything read with one action.

Non-goals:

- Inbox email surfacing in the feed (too noisy; inbox tab exists).
- Observation entries (source is non-deterministic; defer).
- Per-user server-side feed sync (local-only for v1).

## Scope of the feed

Four entry types:

1. `reminder` — a reminder's local notification fired.
2. `digest` — the daily digest fired.
3. `calendarPreAlert` — a calendar pre-alert fired.
4. `reminderAdded` — Claude (or the user) added a reminder.

Entries with a future `firesAt` are hidden from the list until that time passes. This lets the scheduling paths record once up-front and the feed reveals them naturally.

## Architecture

New module `src/lib/notification-feed.ts` — AsyncStorage-backed, user-scoped, subscribe/hydrate pattern matching `memory-store.ts`. All recording flows through `recordFeedEntry(entry)`; all reads through `subscribeFeed()` / `listFeedEntries()`.

Entries are recorded from two sources:

- `notifications.ts` — after each successful OS schedule (`reminder`, `digest`, `calendarPreAlert`).
- `memory-store.ts#addReminder` — records a `reminderAdded` entry.

One screen `src/screens/NotificationsScreen.tsx` shown as a slide-up overlay similar to `InboxDetailScreen` — no tab bar pollution.

### Files

**New:**

- `src/lib/notification-feed.ts` — store, types, `recordFeedEntry`, `markFeedEntryRead`, `markAllFeedRead`, `markFeedByPayload`, `subscribeFeed`, `listFeedEntries`.
- `src/screens/NotificationsScreen.tsx` — UI: header with close + "Markér alle som læst", list grouped by day, empty state.

**Modified:**

- `src/lib/notifications.ts` — after each successful `scheduleNotificationAsync`, call `recordFeedEntry` with a deterministic ID.
- `src/lib/memory-store.ts` — in `addReminder`, after successful persist, record a `reminderAdded` entry.
- `src/lib/hooks.ts` — add `useNotificationFeed()` and `useUnreadNotificationCount()`.
- `App.tsx` — initialize feed at startup, add overlay state for NotificationsScreen, on OS notification tap call `markFeedByPayload` (so tapping a system notification also marks the feed entry read), pass `onOpenNotifications` to TodayScreen.
- `src/screens/TodayScreen.tsx` — bell icon gains an unread dot badge and opens NotificationsScreen. Prop changes from `onGoToMemory` to `onOpenNotifications` (Memory is still reachable via tab bar).

### Entry shape

```ts
export type FeedEntryType = 'reminder' | 'digest' | 'calendarPreAlert' | 'reminderAdded';

export type FeedEntry = {
  id: string;           // deterministic, see IDs below
  type: FeedEntryType;
  title: string;
  body?: string;
  firesAt: Date;        // hide entries where firesAt > now
  createdAt: Date;      // when we recorded it
  readAt: Date | null;
  payload: NotificationPayload; // drives deep-link routing
};
```

### Deterministic IDs (idempotent recording)

- `reminder:<reminderId>:<firesAtMs>`
- `digest:<YYYY-MM-DD>`
- `calendar:<eventId>:<firesAtMs>`
- `reminderAdded:<reminderId>`

Calendar pre-alerts reconcile every foreground (cancel-all, reschedule) — deterministic IDs make re-records cheap no-ops. If a reminder's `dueAt` is edited, a fresh entry appears for the new time; the stale one expires naturally.

### Limits

- Cap at 100 entries. On write, drop the oldest.
- Drop entries older than 30 days on hydrate.

## Data flow

### Scheduling a notification

1. Caller (reminder creation / foreground sync / digest sync) invokes a `notifications.ts` schedule function.
2. After OS schedule succeeds, `notifications.ts` calls `recordFeedEntry({...})`.
3. Feed store writes to cache, notifies listeners, persists to AsyncStorage.
4. If the entry's `firesAt` is in the future, it stays hidden; the bell badge only counts entries where `firesAt <= now && readAt == null`.

### Adding a reminder

1. `memory-store.ts#addReminder` persists the reminder, schedules the OS notification (which records its own entry if dueAt exists), and also records a separate `reminderAdded` entry with `firesAt = createdAt` so it's immediately visible.

### Opening the feed

1. User taps bell on TodayScreen.
2. NotificationsScreen slides up.
3. `useNotificationFeed()` returns the list filtered by `firesAt <= now`, sorted newest-first, grouped by day.

### Tapping a feed row

1. Row's onPress:
   - calls `markFeedEntryRead(id)`
   - closes the overlay
   - routes to the relevant tab via a prop passed down from App.tsx

### Tapping an OS notification

1. Existing response handler in App.tsx routes to the tab.
2. Additionally: call `markFeedByPayload(payload)` to mark the matching feed entry read so the user doesn't see it as unread next time they open the feed.

## Unread semantics

- An entry is unread when `readAt == null && firesAt <= now`.
- The badge count is the number of unread entries.
- Entries are only marked read on explicit user action (row tap, OS tap, "Markér alle").
- Simply opening the feed does NOT mark everything read.

## UI

### Bell badge (TodayScreen)

Small red dot on the top-right of the existing bell icon. No number — this matches the calm aesthetic of the app. Count > 0 → dot visible.

### NotificationsScreen

Header row: close (X) left, "Notifikationer" title, "Markér alle" text button right. Below:

- If list empty: `EmptyState` with mood="calm" and a soft message in Danish ("Ingen notifikationer endnu").
- Else: sections grouped by day ("I dag", "I går", then "21. apr" style). Rows show:
  - Leading icon by type (Bell for reminder, Sun for digest, Calendar for pre-alert, BookmarkPlus for reminderAdded)
  - Title (bold)
  - Body/subtitle (if present)
  - Relative time (right-aligned: "14:02", "i går 08:00", "21. apr")
  - Unread dot on the left edge

Tapping a row marks it read and deep-links:
- `reminder` / `digest` / `reminderAdded` → close feed + switch to `today` tab
- `calendarPreAlert` → close feed + switch to `calendar` tab

## Error handling

| Scenario | Behavior |
|---|---|
| AsyncStorage read/write fails | Log in `__DEV__`, proceed with in-memory cache. |
| User switches accounts mid-session | Same subscribeUserId pattern as memory-store: cache clears, rehydrates from new user's key. |
| Duplicate recordFeedEntry call (e.g. pre-alert reconciliation) | Deterministic ID makes it a no-op (skip if ID exists). |
| Entry count exceeds 100 | On write, drop the oldest by createdAt. |
| Entry older than 30 days | Dropped on hydrate. |

## Testing strategy

Manual against a dev build (no unit framework). Checklist:

**Recording**
- Add a reminder with dueAt = now + 30s → feed shows `reminderAdded` immediately and `reminder` entry appears after it fires.
- Schedule daily digest, wait past 8am, reopen feed → `digest` entry appears.
- Accept a calendar event 16 min out, foreground the app → `calendarPreAlert` entry appears after the pre-alert fires.

**Badge**
- Badge dot appears when any `firesAt <= now && readAt == null` exists.
- Badge disappears after "Markér alle" is tapped.
- Badge disappears after all individual rows are tapped.

**Tap routing**
- Tap reminder row → feed closes, Today tab active.
- Tap calendar pre-alert row → feed closes, Calendar tab active.
- Tap OS notification → feed entry shows as read next time feed opens.

**Cross-account isolation**
- Sign out and sign in as different user → feed is empty, no leakage.

**Persistence / limits**
- Close and reopen app → feed contents persist.
- Record 101 entries → oldest one falls out.
- Entries older than 30 days (fake by editing AsyncStorage in dev) → dropped on hydrate.

## Open implementation details

- Exact styling of the unread dot and section headers — pick values consistent with existing `Pill` / `Stone` / `EmptyState` components during implementation.
- Whether to debounce AsyncStorage writes (probably unnecessary given low frequency).
