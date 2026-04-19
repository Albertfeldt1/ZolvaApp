# Notifications Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project 1 from `docs/superpowers/specs/2026-04-19-notifications-foundation-design.md` — local notifications for reminders, daily digest, and calendar pre-alerts, with per-type Settings toggles and deep-link routing on tap.

**Architecture:** All `expo-notifications` imports live in a single `src/lib/notifications.ts` module. Callers use a typed API. Settings live in a parallel `src/lib/notification-settings.ts` store. Calendar fetch happens on app foreground; pre-alert reconciliation is "cancel all, reschedule".

**Tech Stack:** Expo (SDK 54), React Native 0.81, `expo-notifications`, AsyncStorage, TypeScript.

## Testing note

This project has **no unit test framework** and the spec explicitly defers introducing one. TDD-style failing-test-first is replaced with:

1. **Typecheck gate:** every task runs `npm run typecheck` and must pass.
2. **Manual verification steps** with expected UI behavior, executed against a dev build on a physical iOS device (Expo Go is insufficient for notifications per project memory).
3. **Frequent commits** — one per task.

Do not add Jest, Vitest, or any test runner as part of this plan. That's scope creep.

## Dev build prerequisite

Local notifications require a dev client build, not Expo Go. The repo already has an `ios/` folder, so `expo-notifications` will need `pod install` after installation (Task 1 handles this). Before starting Task 13's manual verification, run `npm run ios` once to produce a dev build on a connected device. Tasks 1–12 can be implemented and typechecked without a device.

## File map

**Create:**
- `src/lib/notifications.ts` — central module; only file that imports `expo-notifications`.
- `src/lib/notification-settings.ts` — AsyncStorage-backed toggles.
- `src/lib/calendar-events-today.ts` — normalizes Google/Microsoft events for pre-alert scheduling.

**Modify:**
- `src/lib/types.ts` — `Reminder.dueAt: Date | null`.
- `src/lib/memory-store.ts` — remove 1h default, call schedule/cancel, accept null.
- `src/lib/google-calendar.ts` — extend event type and query to include attendees + responseStatus.
- `src/lib/microsoft-graph.ts` — extend event type and query to include attendees + responseStatus.
- `App.tsx` — register response handler, AppState listener for foreground sync.
- `src/screens/SettingsScreen.tsx` — three toggle rows + optional system-settings banner.
- `app.json` — `expo-notifications` plugin config.
- `package.json` — dependency.

**Consumers of `reminder.dueAt` to audit in Task 2:**
Any file that reads `reminder.dueAt` must handle `null`. Expected suspects: `src/screens/TodayScreen.tsx`, `src/screens/MemoryScreen.tsx`, `src/lib/hooks.ts`. Task 2 finds them via grep and adjusts.

---

## Task 1: Install and configure `expo-notifications`

**Files:**
- Modify: `package.json`
- Modify: `app.json`
- New native pods installed via CocoaPods

- [ ] **Step 1: Install the package**

Run: `npx expo install expo-notifications`

Expected: `package.json` gets a `"expo-notifications"` entry pinned to a version compatible with Expo SDK 54. No manual version edits.

- [ ] **Step 2: Add plugin config to `app.json`**

Edit `app.json`, changing the `plugins` array and adding iOS permission strings. Full new contents of `app.json`:

```json
{
  "expo": {
    "name": "Zolva",
    "slug": "zolva-app",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "newArchEnabled": true,
    "scheme": "zolva",
    "splash": {
      "image": "./assets/splash-icon.png",
      "resizeMode": "contain",
      "backgroundColor": "#ffffff"
    },
    "ios": {
      "supportsTablet": true,
      "usesAppleSignIn": true,
      "bundleIdentifier": "com.zolva.app",
      "infoPlist": {
        "NSUserNotificationsUsageDescription": "Zolva sender notifikationer om påmindelser, dagens overblik og kommende møder."
      }
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/adaptive-icon.png",
        "backgroundColor": "#ffffff"
      },
      "edgeToEdgeEnabled": true,
      "predictiveBackGestureEnabled": false
    },
    "web": {
      "favicon": "./assets/favicon.png"
    },
    "plugins": [
      "expo-font",
      "expo-web-browser",
      "expo-apple-authentication",
      [
        "expo-notifications",
        {
          "color": "#ffffff"
        }
      ]
    ]
  }
}
```

- [ ] **Step 3: Re-run native prebuild so iOS picks up the new plugin**

Run: `npx expo prebuild --platform ios --clean`

Expected: `ios/` directory is regenerated; `Podfile` now references `ExpoNotifications`. No warnings about missing modules.

Note: `prebuild --clean` will wipe and regenerate the `ios/` folder. If there are uncommitted native changes in `ios/`, commit them first.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json app.json ios/
git commit -m "chore: install expo-notifications and configure plugin"
```

---

## Task 2: Make `Reminder.dueAt` nullable and audit consumers

**Files:**
- Modify: `src/lib/types.ts:128-134`
- Modify: `src/lib/memory-store.ts:29-37, 132-147`
- Audit: any file reading `reminder.dueAt`

- [ ] **Step 1: Update the `Reminder` type**

Edit `src/lib/types.ts`, replacing the `Reminder` type (lines 128–134) with:

```ts
export type Reminder = {
  id: string;
  text: string;
  dueAt: Date | null;
  status: ReminderStatus;
  createdAt: Date;
};
```

- [ ] **Step 2: Update `reviveReminder` to preserve nullability**

In `src/lib/memory-store.ts`, replace the `reviveReminder` function (around lines 29–37) with:

```ts
function reviveReminder(raw: unknown): Reminder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Reminder> & { dueAt?: string | Date | null; createdAt?: string | Date };
  if (typeof r.id !== 'string' || typeof r.text !== 'string') return null;
  const dueAt =
    r.dueAt == null
      ? null
      : r.dueAt instanceof Date
        ? r.dueAt
        : new Date(r.dueAt);
  const createdAt = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt ?? Date.now());
  const status: ReminderStatus = r.status === 'done' ? 'done' : 'pending';
  return { id: r.id, text: r.text, dueAt, createdAt, status };
}
```

- [ ] **Step 3: Remove the 1-hour default in `addReminder`**

In `src/lib/memory-store.ts`, replace the `addReminder` function (around lines 132–147) with:

```ts
export async function addReminder(text: string, dueAt?: Date | null): Promise<Reminder> {
  await hydrate();
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Reminder text is required');
  const reminder: Reminder = {
    id: genId('r'),
    text: trimmed,
    dueAt: dueAt ?? null,
    createdAt: new Date(),
    status: 'pending',
  };
  remindersCache = [...remindersCache, reminder];
  notifyReminders();
  await persistReminders();
  return reminder;
}
```

- [ ] **Step 4: Find every consumer of `reminder.dueAt`**

Run: `grep -rn "\.dueAt" src/`

Expected: a list of locations. For each location not in `memory-store.ts` or `types.ts`, open the file and ensure it handles `dueAt: null` gracefully. Typical patterns:

- If code formats `dueAt` (`format(reminder.dueAt, ...)`): guard with `if (reminder.dueAt) { ... }` or render `'Uden deadline'` fallback.
- If code sorts/filters by `dueAt`: put `dueAt === null` items at the end (e.g., `(a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)`).
- If code compares to now (`reminder.dueAt < Date.now()`): guard the comparison.

Make the minimum changes needed to keep the UI behavior correct. Do not refactor unrelated code.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0. Fix any type errors the nullability change surfaces.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/memory-store.ts src/
git commit -m "feat: allow reminders without a due time"
```

---

## Task 3: Create `notification-settings.ts` store

**Files:**
- Create: `src/lib/notification-settings.ts`

- [ ] **Step 1: Write the settings module**

Create `src/lib/notification-settings.ts` with this full contents:

```ts
// AsyncStorage-backed toggles for which notification types the user wants.
// Mirrors the subscribe/hydrate pattern in memory-store.ts so UI and the
// notifications module can both read the same source of truth.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type NotificationSettings = {
  reminders: boolean;
  digest: boolean;
  preAlerts: boolean;
};

const STORAGE_KEY = 'zolva.notifications.settings';
const DEFAULTS: NotificationSettings = { reminders: false, digest: false, preAlerts: false };

let cache: NotificationSettings = DEFAULTS;
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

const listeners = new Set<(s: NotificationSettings) => void>();

function notify() {
  const snapshot = cache;
  listeners.forEach((l) => l(snapshot));
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
        cache = {
          reminders: parsed.reminders === true,
          digest: parsed.digest === true,
          preAlerts: parsed.preAlerts === true,
        };
      }
    } catch (err) {
      if (__DEV__) console.warn('[notification-settings] hydrate failed:', err);
    }
    hydrated = true;
    notify();
  })();
  return hydrationPromise;
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (err) {
    if (__DEV__) console.warn('[notification-settings] persist failed:', err);
  }
}

export function initNotificationSettings(): void {
  void hydrate();
}

export function getNotificationSettings(): NotificationSettings {
  return cache;
}

export function subscribeNotificationSettings(
  listener: (s: NotificationSettings) => void,
): () => void {
  listeners.add(listener);
  void hydrate();
  listener(cache);
  return () => {
    listeners.delete(listener);
  };
}

export async function setNotificationSetting<K extends keyof NotificationSettings>(
  key: K,
  value: NotificationSettings[K],
): Promise<void> {
  await hydrate();
  cache = { ...cache, [key]: value };
  notify();
  await persist();
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/notification-settings.ts
git commit -m "feat: persisted toggle store for notification types"
```

---

## Task 4: Create `notifications.ts` — permissions + foreground handler

**Files:**
- Create: `src/lib/notifications.ts`

- [ ] **Step 1: Write the module skeleton with permissions and the foreground handler**

Create `src/lib/notifications.ts` with:

```ts
// Central module for all local notifications. Only file that imports
// expo-notifications. Callers use this typed API; implementation details
// (identifier scheme, OS calls) live here.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Reminder } from './types';
import { getNotificationSettings } from './notification-settings';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

export type NotificationPayload =
  | { type: 'reminder'; reminderId: string }
  | { type: 'digest'; date: string }
  | { type: 'calendarPreAlert'; eventId: string };

// Foreground presentation: show a banner, no sound, no badge. This runs
// for every notification that fires while the app is active.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Android requires a channel for notifications to appear. Register it once
// at module load. No-op on iOS.
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('default', {
    name: 'Zolva',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch((err) => {
    if (__DEV__) console.warn('[notifications] channel setup failed:', err);
  });
}

function normalizeStatus(
  status: Notifications.PermissionStatus,
): PermissionStatus {
  if (status === Notifications.PermissionStatus.GRANTED) return 'granted';
  if (status === Notifications.PermissionStatus.DENIED) return 'denied';
  return 'undetermined';
}

export async function getPermissionStatus(): Promise<PermissionStatus> {
  const { status } = await Notifications.getPermissionsAsync();
  return normalizeStatus(status);
}

export async function ensurePermission(): Promise<PermissionStatus> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === Notifications.PermissionStatus.GRANTED) return 'granted';
  if (current.status === Notifications.PermissionStatus.DENIED && !current.canAskAgain) {
    return 'denied';
  }
  const next = await Notifications.requestPermissionsAsync();
  return normalizeStatus(next.status);
}

export function registerResponseHandler(
  onTap: (payload: NotificationPayload) => void,
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as unknown;
    if (!data || typeof data !== 'object') return;
    const payload = data as Partial<NotificationPayload> & { type?: string };
    if (payload.type === 'reminder' && typeof (payload as { reminderId?: unknown }).reminderId === 'string') {
      onTap({ type: 'reminder', reminderId: (payload as { reminderId: string }).reminderId });
    } else if (payload.type === 'digest' && typeof (payload as { date?: unknown }).date === 'string') {
      onTap({ type: 'digest', date: (payload as { date: string }).date });
    } else if (
      payload.type === 'calendarPreAlert' &&
      typeof (payload as { eventId?: unknown }).eventId === 'string'
    ) {
      onTap({ type: 'calendarPreAlert', eventId: (payload as { eventId: string }).eventId });
    }
  });
  return () => sub.remove();
}

// Placeholder — filled in by later tasks.
export async function scheduleReminderNotification(_reminder: Reminder): Promise<void> {
  void getNotificationSettings;
}

export async function cancelReminderNotification(_reminderId: string): Promise<void> {
  // filled in later
}

export async function syncDailyDigest(): Promise<void> {
  // filled in later
}

export async function syncCalendarPreAlerts(_events: never[]): Promise<void> {
  // filled in later
}

export async function syncOnAppForeground(): Promise<void> {
  // filled in later
}
```

The stub exports exist so callers added in later tasks compile against a stable API. Tasks 5, 6, 9, 10 fill in the bodies.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/notifications.ts
git commit -m "feat: notifications module with permissions and foreground handler"
```

---

## Task 5: Implement `scheduleReminderNotification` and `cancelReminderNotification`

**Files:**
- Modify: `src/lib/notifications.ts`
- Modify: `src/lib/memory-store.ts`

- [ ] **Step 1: Implement reminder scheduling in `notifications.ts`**

Replace the `scheduleReminderNotification` and `cancelReminderNotification` stubs with:

```ts
export async function scheduleReminderNotification(reminder: Reminder): Promise<void> {
  const settings = getNotificationSettings();
  if (!settings.reminders) return;
  if (!reminder.dueAt) return;
  if (reminder.dueAt.getTime() <= Date.now()) return;

  const permission = await getPermissionStatus();
  if (permission !== 'granted') return;

  const identifier = reminderIdentifier(reminder.id);
  // Cancel any prior scheduled version first so edits don't double-fire.
  try {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  } catch {
    // iOS throws if the identifier is unknown; that's fine.
  }

  try {
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: 'Påmindelse',
        body: reminder.text,
        data: { type: 'reminder', reminderId: reminder.id } satisfies NotificationPayload,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: reminder.dueAt,
      },
    });
  } catch (err) {
    if (__DEV__) console.warn('[notifications] schedule reminder failed:', err);
  }
}

export async function cancelReminderNotification(reminderId: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(reminderIdentifier(reminderId));
  } catch {
    // Unknown identifier on iOS throws; treat as no-op.
  }
}

function reminderIdentifier(id: string): string {
  return `reminder:${id}`;
}
```

- [ ] **Step 2: Wire memory-store to schedule/cancel**

In `src/lib/memory-store.ts`, add an import at the top (after the existing imports):

```ts
import {
  cancelReminderNotification,
  scheduleReminderNotification,
} from './notifications';
```

Then update `addReminder`, `markReminderDone`, and `removeReminder` (replacing them in place):

```ts
export async function addReminder(text: string, dueAt?: Date | null): Promise<Reminder> {
  await hydrate();
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Reminder text is required');
  const reminder: Reminder = {
    id: genId('r'),
    text: trimmed,
    dueAt: dueAt ?? null,
    createdAt: new Date(),
    status: 'pending',
  };
  remindersCache = [...remindersCache, reminder];
  notifyReminders();
  await persistReminders();
  void scheduleReminderNotification(reminder);
  return reminder;
}

export async function markReminderDone(id: string): Promise<void> {
  await hydrate();
  remindersCache = remindersCache.map((r) => (r.id === id ? { ...r, status: 'done' } : r));
  notifyReminders();
  await persistReminders();
  void cancelReminderNotification(id);
}

export async function removeReminder(id: string): Promise<void> {
  await hydrate();
  remindersCache = remindersCache.filter((r) => r.id !== id);
  notifyReminders();
  await persistReminders();
  void cancelReminderNotification(id);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/notifications.ts src/lib/memory-store.ts
git commit -m "feat: schedule and cancel local notifications for reminders"
```

---

## Task 6: Implement `syncDailyDigest`

**Files:**
- Modify: `src/lib/notifications.ts`

- [ ] **Step 1: Replace the `syncDailyDigest` stub**

Add a helper and replace the stub:

```ts
function digestIdentifier(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `digest:${y}-${m}-${d}`;
}

// Next 8am in local time. If it's already past 8am today, returns tomorrow.
function nextDigestDate(now: Date): Date {
  const target = new Date(now);
  target.setHours(8, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

export async function syncDailyDigest(): Promise<void> {
  const settings = getNotificationSettings();
  if (!settings.digest) return;

  const permission = await getPermissionStatus();
  if (permission !== 'granted') return;

  const when = nextDigestDate(new Date());
  const identifier = digestIdentifier(when);

  // Idempotent: if this exact digest is already scheduled, skip.
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  if (scheduled.some((s) => s.identifier === identifier)) return;

  // Clean up any stale digest:* from prior days so we don't accumulate.
  for (const s of scheduled) {
    if (s.identifier.startsWith('digest:')) {
      try {
        await Notifications.cancelScheduledNotificationAsync(s.identifier);
      } catch {
        // ignore
      }
    }
  }

  try {
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: 'God morgen',
        body: 'Dit overblik for i dag er klar.',
        data: { type: 'digest', date: identifier.slice('digest:'.length) } satisfies NotificationPayload,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: when,
      },
    });
  } catch (err) {
    if (__DEV__) console.warn('[notifications] schedule digest failed:', err);
  }
}
```

Note on digest body: the spec says "one-line headline (counts), not a summary". The initial implementation uses a fixed Danish copy because computing counts ("3 events, 2 emails, 1 reminder") requires reading from multiple data sources at schedule time, and the notification is scheduled hours in advance — counts would be stale by 8am. A follow-up task (outside this plan) can upgrade to computing a fresher count via a just-in-time trigger if desired. For now, the tap behavior (opens TodayScreen with live counts) carries the weight.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/notifications.ts
git commit -m "feat: schedule daily digest at next 8am local"
```

---

## Task 7: Extend calendar clients to include attendees and response status

**Files:**
- Modify: `src/lib/google-calendar.ts`
- Modify: `src/lib/microsoft-graph.ts`

- [ ] **Step 1: Extend Google Calendar event type and query**

Replace `src/lib/google-calendar.ts` contents with:

```ts
// Minimal Google Calendar client. Reads events from the user's primary
// calendar using the OAuth provider_token returned by Supabase after
// signing in with Google (scope: calendar.readonly).

import { ProviderAuthError, tryWithRefresh } from './auth';

const BASE = 'https://www.googleapis.com/calendar/v3';

export type GoogleCalendarAttendee = {
  email?: string;
  self?: boolean;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
};

export type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: GoogleCalendarAttendee[];
};

export async function listEvents(
  timeMin: Date,
  timeMax: Date,
): Promise<GoogleCalendarEvent[]> {
  return tryWithRefresh('google', async (accessToken) => {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
    const url = `${BASE}/calendars/primary/events?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Google Calendar afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Google Calendar API ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { items?: GoogleCalendarEvent[] };
    return json.items ?? [];
  });
}

export function eventStart(e: GoogleCalendarEvent): Date | null {
  const raw = e.start.dateTime ?? e.start.date;
  if (!raw) return null;
  return new Date(raw);
}

export function eventEnd(e: GoogleCalendarEvent): Date | null {
  const raw = e.end.dateTime ?? e.end.date;
  if (!raw) return null;
  return new Date(raw);
}

export function isAllDay(e: GoogleCalendarEvent): boolean {
  return !e.start.dateTime && !!e.start.date;
}

// True when the event has at least one attendee other than the signed-in
// user. Google includes the organizer themselves in `attendees`; we treat
// events with only the `self: true` attendee as solo.
export function hasOtherAttendees(e: GoogleCalendarEvent): boolean {
  const list = e.attendees ?? [];
  return list.some((a) => a.self !== true);
}

// True when the signed-in user has accepted the event. If there are no
// attendees at all, this returns true (solo events count as accepted even
// though `hasOtherAttendees` will filter them out separately).
export function userAccepted(e: GoogleCalendarEvent): boolean {
  const list = e.attendees ?? [];
  if (list.length === 0) return true;
  const me = list.find((a) => a.self === true);
  if (!me) return true;
  return me.responseStatus === 'accepted';
}
```

Google's `events.list` returns `attendees` by default when they're present, so no query param change is required. The normalization helpers (`hasOtherAttendees`, `userAccepted`) centralize the filter logic so Task 8 doesn't duplicate it.

- [ ] **Step 2: Extend Microsoft Graph event type and query**

Replace the `GraphCalendarEvent` type, `RawEvent` type, and `listCalendarEvents` function in `src/lib/microsoft-graph.ts`. The updated pieces:

```ts
export type GraphAttendeeStatus = 'none' | 'accepted' | 'tentativelyAccepted' | 'declined' | 'notResponded' | 'organizer';

export type GraphCalendarEvent = {
  id: string;
  subject: string;
  start: Date;
  end: Date;
  location?: string;
  isAllDay: boolean;
  hasOtherAttendees: boolean;
  userResponse: GraphAttendeeStatus;
};
```

Replace `RawEvent`:

```ts
type RawEvent = {
  id: string;
  subject?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  location?: { displayName?: string };
  isAllDay?: boolean;
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  responseStatus?: { response?: GraphAttendeeStatus };
};
```

Replace `listCalendarEvents`:

```ts
export async function listCalendarEvents(
  start: Date,
  end: Date,
): Promise<GraphCalendarEvent[]> {
  return tryWithRefresh('microsoft', async (token) => {
    const path =
      `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}` +
      `&$select=id,subject,start,end,location,isAllDay,attendees,responseStatus` +
      `&$orderby=start/dateTime&$top=50`;
    const data = await graphFetch<{ value: RawEvent[] }>(token, path);
    return data.value.map((e) => ({
      id: e.id,
      subject: e.subject || 'Uden titel',
      start: new Date(`${e.start.dateTime}Z`),
      end: new Date(`${e.end.dateTime}Z`),
      location: e.location?.displayName,
      isAllDay: e.isAllDay ?? false,
      hasOtherAttendees: (e.attendees ?? []).length > 0,
      userResponse: e.responseStatus?.response ?? 'none',
    }));
  });
}
```

Graph includes the organizer as a non-attendee, so `attendees.length > 0` correctly distinguishes meetings from solo blocks. `userResponse: 'organizer'` counts as accepted (you own the meeting).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0. If any consumer of `GraphCalendarEvent` breaks on the new required fields, that's fine — fix the consumers by ignoring the new fields (they're additive).

- [ ] **Step 4: Commit**

```bash
git add src/lib/google-calendar.ts src/lib/microsoft-graph.ts
git commit -m "feat: surface attendees and response status on calendar events"
```

---

## Task 8: Create `calendar-events-today.ts` — normalize and filter

**Files:**
- Create: `src/lib/calendar-events-today.ts`

- [ ] **Step 1: Write the normalizer**

Create `src/lib/calendar-events-today.ts`:

```ts
// Fetches today's calendar events from whichever providers are connected,
// normalizes them, and filters down to ones eligible for a 15-minute
// pre-alert. Returns an empty array on any fetch failure (best-effort).

import {
  hasOtherAttendees as googleHasOtherAttendees,
  isAllDay as googleIsAllDay,
  listEvents as listGoogleEvents,
  userAccepted as googleUserAccepted,
  eventStart as googleEventStart,
  type GoogleCalendarEvent,
} from './google-calendar';
import {
  listCalendarEvents as listGraphEvents,
  type GraphCalendarEvent,
} from './microsoft-graph';

export type CalendarEventForAlert = {
  id: string;
  title: string;
  start: Date;
  source: 'google' | 'microsoft';
};

function endOfToday(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

function passesGoogleFilter(e: GoogleCalendarEvent, now: Date): CalendarEventForAlert | null {
  const start = googleEventStart(e);
  if (!start) return null;
  if (googleIsAllDay(e)) return null;
  if (start.getTime() <= now.getTime() + 15 * 60 * 1000) return null;
  if (!googleHasOtherAttendees(e)) return null;
  if (!googleUserAccepted(e)) return null;
  return {
    id: `google:${e.id}`,
    title: e.summary ?? 'Uden titel',
    start,
    source: 'google',
  };
}

function passesGraphFilter(e: GraphCalendarEvent, now: Date): CalendarEventForAlert | null {
  if (e.isAllDay) return null;
  if (e.start.getTime() <= now.getTime() + 15 * 60 * 1000) return null;
  if (!e.hasOtherAttendees) return null;
  if (e.userResponse !== 'accepted' && e.userResponse !== 'organizer') return null;
  return {
    id: `microsoft:${e.id}`,
    title: e.subject,
    start: e.start,
    source: 'microsoft',
  };
}

export async function fetchPreAlertEligibleEvents(): Promise<CalendarEventForAlert[]> {
  const now = new Date();
  const end = endOfToday(now);
  const results: CalendarEventForAlert[] = [];

  const google = await listGoogleEvents(now, end).catch((err) => {
    if (__DEV__) console.warn('[calendar-events-today] google fetch failed:', err);
    return [] as GoogleCalendarEvent[];
  });
  for (const e of google) {
    const passed = passesGoogleFilter(e, now);
    if (passed) results.push(passed);
  }

  const graph = await listGraphEvents(now, end).catch((err) => {
    if (__DEV__) console.warn('[calendar-events-today] graph fetch failed:', err);
    return [] as GraphCalendarEvent[];
  });
  for (const e of graph) {
    const passed = passesGraphFilter(e, now);
    if (passed) results.push(passed);
  }

  return results;
}
```

Failure mode: if the user isn't signed into Google, `listGoogleEvents` throws a `ProviderAuthError`. We catch and return empty. Same for Graph. The net effect when neither provider is connected is an empty array — no pre-alerts scheduled, which is correct.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/calendar-events-today.ts
git commit -m "feat: normalize and filter today's events for pre-alert eligibility"
```

---

## Task 9: Implement `syncCalendarPreAlerts`

**Files:**
- Modify: `src/lib/notifications.ts`

- [ ] **Step 1: Update the stub and the placeholder type**

In `src/lib/notifications.ts`, add an import at the top:

```ts
import type { CalendarEventForAlert } from './calendar-events-today';
```

Replace the `syncCalendarPreAlerts` stub with:

```ts
function calendarIdentifier(eventId: string): string {
  return `calendar:${eventId}`;
}

export async function syncCalendarPreAlerts(events: CalendarEventForAlert[]): Promise<void> {
  const settings = getNotificationSettings();
  if (!settings.preAlerts) return;

  const permission = await getPermissionStatus();
  if (permission !== 'granted') return;

  // Cancel all existing calendar:* notifications. The cost of rescheduling
  // ~10 events is trivial and avoids diffing bugs.
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const s of scheduled) {
    if (s.identifier.startsWith('calendar:')) {
      try {
        await Notifications.cancelScheduledNotificationAsync(s.identifier);
      } catch {
        // ignore
      }
    }
  }

  // Schedule a 15-minute-before alert for each eligible event.
  for (const event of events) {
    const fireAt = new Date(event.start.getTime() - 15 * 60 * 1000);
    if (fireAt.getTime() <= Date.now()) continue;
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: calendarIdentifier(event.id),
        content: {
          title: event.title,
          body: 'Starter om 15 minutter.',
          data: { type: 'calendarPreAlert', eventId: event.id } satisfies NotificationPayload,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
        },
      });
    } catch (err) {
      if (__DEV__) console.warn('[notifications] schedule pre-alert failed:', err);
    }
  }
}
```

Also update the `syncCalendarPreAlerts` parameter type in the earlier signature (remove the `never[]` placeholder from Task 4). The replacement above already has the correct signature.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/notifications.ts
git commit -m "feat: schedule 15-minute calendar pre-alerts with reconciliation"
```

---

## Task 10: Implement `syncOnAppForeground` and wire AppState

**Files:**
- Modify: `src/lib/notifications.ts`
- Modify: `App.tsx`

- [ ] **Step 1: Implement the foreground coordinator**

In `src/lib/notifications.ts`, replace the `syncOnAppForeground` stub with:

```ts
import { fetchPreAlertEligibleEvents } from './calendar-events-today';

export async function syncOnAppForeground(): Promise<void> {
  // Both syncs are independent; run sequentially to keep the code simple.
  await syncDailyDigest();
  const events = await fetchPreAlertEligibleEvents();
  await syncCalendarPreAlerts(events);
}
```

(Move the `fetchPreAlertEligibleEvents` import to the top of the file alongside the other imports.)

- [ ] **Step 2: Wire AppState in `App.tsx`**

In `App.tsx`, add imports at the top:

```ts
import { AppState } from 'react-native';
import { syncOnAppForeground } from './src/lib/notifications';
import { initNotificationSettings } from './src/lib/notification-settings';
```

Inside the `App` component body, add a `useEffect` after the `useState` calls:

```ts
useEffect(() => {
  initNotificationSettings();
  void syncOnAppForeground();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void syncOnAppForeground();
  });
  return () => sub.remove();
}, []);
```

Also add `useEffect` to the existing React import:

```ts
import React, { useEffect, useMemo, useState } from 'react';
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/notifications.ts App.tsx
git commit -m "feat: reconcile digest and pre-alerts on app foreground"
```

---

## Task 11: Notification tap handler and deep-link routing

**Files:**
- Modify: `App.tsx`

- [ ] **Step 1: Register the response handler and route taps**

In `App.tsx`, add an import:

```ts
import { registerResponseHandler } from './src/lib/notifications';
```

Add another `useEffect` inside the `App` component (after the foreground one from Task 10):

```ts
useEffect(() => {
  const unsub = registerResponseHandler((payload) => {
    // Close any overlay so the user lands on the target screen.
    setChatOpen(false);
    setOpenMail(null);
    switch (payload.type) {
      case 'reminder':
      case 'digest':
        setTab('today');
        break;
      case 'calendarPreAlert':
        setTab('calendar');
        break;
    }
  });
  return unsub;
}, []);
```

Note: there's no "event detail" screen today, so calendar pre-alerts just land on the calendar tab. The design doc flagged this as acceptable; adding event detail is out of scope.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add App.tsx
git commit -m "feat: route notification taps to the relevant tab"
```

---

## Task 12: Settings screen — three toggles with just-in-time permission

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add a hook for notification settings**

Open `src/screens/SettingsScreen.tsx`. Add imports near the top:

```ts
import { Linking } from 'react-native';
import {
  ensurePermission,
  getPermissionStatus,
  syncOnAppForeground,
  type PermissionStatus,
} from '../lib/notifications';
import {
  getNotificationSettings,
  setNotificationSetting,
  subscribeNotificationSettings,
  type NotificationSettings,
} from '../lib/notification-settings';
```

Add a local hook near the top of the file (above the `SettingsScreen` function):

```ts
function useNotificationSettings(): NotificationSettings {
  const [state, setState] = useState<NotificationSettings>(getNotificationSettings());
  useEffect(() => subscribeNotificationSettings(setState), []);
  return state;
}

function useNotificationPermission(): PermissionStatus {
  const [status, setStatus] = useState<PermissionStatus>('undetermined');
  useEffect(() => {
    let alive = true;
    void getPermissionStatus().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}
```

Add `useEffect` to the existing React import if it isn't already imported.

- [ ] **Step 2: Render the three toggles**

Inside `SettingsScreen`, after the existing `const { bottom: chromeBottom } = useChromeInsets();` line, add:

```ts
const notificationSettings = useNotificationSettings();
const permission = useNotificationPermission();

const toggleNotificationSetting = async (key: keyof NotificationSettings, next: boolean) => {
  if (next) {
    const result = await ensurePermission();
    if (result !== 'granted') {
      Alert.alert(
        'Tillad notifikationer',
        'Zolva kan ikke sende notifikationer før du giver tilladelse i systemindstillingerne.',
        [
          { text: 'Ikke nu', style: 'cancel' },
          { text: 'Åbn indstillinger', onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }
  }
  await setNotificationSetting(key, next);
  // Reflect changes immediately — e.g., enabling digest schedules it now.
  void syncOnAppForeground();
};
```

Insert a notifications section into the rendered JSX, above the sign-out / disconnect section. Place it after the work preferences block. The block itself:

```tsx
<View style={styles.section}>
  <Text style={styles.sectionTitle}>Notifikationer</Text>
  {permission === 'denied' ? (
    <Pressable style={styles.permissionBanner} onPress={() => Linking.openSettings()}>
      <Text style={styles.permissionBannerText}>
        Notifikationer er slået fra i systemindstillingerne. Tryk for at åbne.
      </Text>
    </Pressable>
  ) : null}
  <NotificationToggleRow
    label="Påmindelser"
    value={notificationSettings.reminders}
    onChange={(v) => toggleNotificationSetting('reminders', v)}
  />
  <NotificationToggleRow
    label="Morgenoverblik kl. 8"
    value={notificationSettings.digest}
    onChange={(v) => toggleNotificationSetting('digest', v)}
  />
  <NotificationToggleRow
    label="Kalender-påmindelse 15 min før"
    value={notificationSettings.preAlerts}
    onChange={(v) => toggleNotificationSetting('preAlerts', v)}
  />
</View>
```

Add the `NotificationToggleRow` component definition at the bottom of the file (above the styles definition):

```tsx
function NotificationToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Pressable style={styles.toggleRow} onPress={() => onChange(!value)}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <View style={[styles.toggleTrack, value ? styles.toggleTrackOn : styles.toggleTrackOff]}>
        <View style={[styles.toggleThumb, value ? styles.toggleThumbOn : styles.toggleThumbOff]} />
      </View>
    </Pressable>
  );
}
```

Extend the `styles` object at the bottom of the file with the new keys:

```ts
section: { gap: 12, marginBottom: 24 },
sectionTitle: { fontSize: 13, color: colors.ink, fontFamily: fonts.serif, marginBottom: 4 },
toggleRow: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingVertical: 12,
  paddingHorizontal: 16,
  backgroundColor: colors.paper,
  borderRadius: 12,
},
toggleLabel: { fontSize: 15, color: colors.ink, fontFamily: fonts.sans, flex: 1 },
toggleTrack: {
  width: 46,
  height: 28,
  borderRadius: 14,
  padding: 3,
},
toggleTrackOn: { backgroundColor: colors.sageDeep },
toggleTrackOff: { backgroundColor: colors.mist },
toggleThumb: {
  width: 22,
  height: 22,
  borderRadius: 11,
  backgroundColor: colors.paper,
},
toggleThumbOn: { marginLeft: 18 },
toggleThumbOff: { marginLeft: 0 },
permissionBanner: {
  padding: 12,
  backgroundColor: colors.clay,
  borderRadius: 12,
  marginBottom: 8,
},
permissionBannerText: { fontSize: 13, color: colors.paper, fontFamily: fonts.sans },
```

If any of these color/font keys don't exist in the theme, substitute the closest existing value. The rendering doesn't need to be pixel-perfect to the rest of Settings; match the visual weight of adjacent sections.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat: notification toggles in Settings with just-in-time permission"
```

---

## Task 13: Dev build and manual verification

**Files:**
- None modified (unless verification uncovers a bug — those get fixed here)

- [ ] **Step 1: Build and run on a physical iOS device**

Connect an iOS device. Run: `npm run ios`

Expected: app launches on the device (not simulator — simulator notification behavior differs). Wait for Metro bundler to finish.

- [ ] **Step 2: Walk the permission flow**

1. Go to Settings tab.
2. Toggle "Påmindelser" on.
3. Expect: iOS permission prompt appears. Tap **Allow**.
4. Expect: toggle stays on, no banner above the section.
5. Kill the app and reopen. Toggle state and permission both persist.

- [ ] **Step 3: Reminder end-to-end**

1. In ChatScreen, ask Zolva: "Remind me in 1 minute to test notifications."
2. Verify a reminder appears in the reminders list with `dueAt` ~1 min out.
3. Lock the device and wait.
4. Expect: notification fires on the lock screen.
5. Tap it. App opens to TodayScreen.

- [ ] **Step 4: Reminder cancellation**

1. Create a reminder with `dueAt` ~2 min out.
2. Immediately mark it done in the reminders list.
3. Wait 2 min with the device locked.
4. Expect: no notification.

- [ ] **Step 5: Reminder without `dueAt`**

1. Create a reminder without a time (e.g., via chat: "Remember that I owe Anna a coffee").
2. Expect: reminder appears in the list but no notification is ever scheduled. (Verify with `Notifications.getAllScheduledNotificationsAsync()` via a temporary dev log, or just wait and confirm nothing fires.)

- [ ] **Step 6: Daily digest**

1. In Settings, enable "Morgenoverblik kl. 8".
2. If current local time is before 8am: a digest is scheduled for today at 8am. If after, for tomorrow at 8am. To verify without waiting, temporarily change `nextDigestDate` in `notifications.ts` to return `new Date(Date.now() + 30 * 1000)`, reload, foreground the app, lock device, wait 30s. **Revert the change immediately after verifying.**
3. Tap the digest notification. App opens to TodayScreen.

- [ ] **Step 7: Calendar pre-alert**

1. Ensure the user is signed into a Google or Microsoft account with calendar access.
2. In that account's calendar, create an event starting in ~30 min with another attendee, and accept it.
3. Foreground the Zolva app. Wait a few seconds.
4. Expect: scheduled notifications now include `calendar:<eventId>` firing at event_start − 15 min. (Confirm via a temporary dev log.)
5. Decline the event from the calendar app. Foreground Zolva again. Expect: the pre-alert is cancelled.

- [ ] **Step 8: Foreground behavior**

1. With the app foregrounded, schedule a reminder 30s out.
2. Wait with the app active.
3. Expect: in-app banner appears at the top, not a full system notification.

- [ ] **Step 9: Permission denied fallback**

1. Revoke notification permission in iOS Settings for Zolva.
2. Reopen Zolva, go to Settings.
3. Expect: red/clay banner above the notification toggles linking to system Settings. Toggling a notification type on prompts the `Allow → Open Settings` dialog.

- [ ] **Step 10: Record the result**

If all steps pass: no code change. Commit a trivial update if anything in the plan needed fixing along the way.

If anything fails: fix inline, re-run the affected verification step, commit the fix with a descriptive message.

- [ ] **Step 11: Final commit (if needed)**

```bash
git status
# Only commit if there are fix-up changes.
```

---

## Self-review

**Spec coverage:**
- Permissions (ensurePermission, just-in-time) — Tasks 4, 12.
- Three toggle types in Settings — Task 12.
- Reminder scheduling with `dueAt: null` handling — Tasks 2, 5.
- Reminder cancel on done/delete — Task 5.
- Daily digest at next 8am, idempotent — Task 6.
- Calendar pre-alerts with attendees + accepted filter — Tasks 7, 8, 9.
- Foreground sync via AppState — Task 10.
- Deep-link routing on tap — Task 11.
- Foreground banner presentation — Task 4.
- Permission-denied banner in Settings — Task 12.
- Manual verification checklist — Task 13.

**Placeholder scan:** no "TBD", no "add appropriate error handling", no "similar to Task N"; all code blocks contain the actual code.

**Type consistency:** `Reminder.dueAt` is `Date | null` consistently from Task 2 onward. `NotificationPayload` used in Tasks 4, 5, 6, 9, 11 matches the definition in Task 4. `CalendarEventForAlert` defined in Task 8 and imported in Task 9. Identifier helpers (`reminderIdentifier`, `digestIdentifier`, `calendarIdentifier`) are consistently named and prefixed.
