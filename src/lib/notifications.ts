// Central module for all local notifications. Only file that imports
// expo-notifications. Callers use this typed API; implementation details
// (identifier scheme, OS calls) live here.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { NotificationPayload, Reminder } from './types';
import { getNotificationSettings } from './notification-settings';
import type { CalendarEventForAlert } from './calendar-events-today';
import { fetchPreAlertEligibleEvents } from './calendar-events-today';
import { recordFeedEntry } from './notification-feed';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

export type { NotificationPayload };

// Module-level set of chat job ids we've already rendered in the live UI.
// The chat-run server always pushes a notification on completion; if the
// app was foregrounded when the answer arrived, useChat displays the
// message in-band and registers the job id here so the foreground handler
// silently consumes the duplicate banner. Capped to keep memory bounded -
// 200 jobs is plenty of headroom for the suppression window.
const acknowledgedChatJobIds: string[] = [];
const ACK_RING_CAP = 200;
export function rememberChatJobAcknowledged(jobId: string): void {
  if (acknowledgedChatJobIds.includes(jobId)) return;
  acknowledgedChatJobIds.push(jobId);
  if (acknowledgedChatJobIds.length > ACK_RING_CAP) acknowledgedChatJobIds.shift();
}
function isChatJobAcknowledged(jobId: string): boolean {
  return acknowledgedChatJobIds.includes(jobId);
}

// Foreground presentation: show a banner, no sound, no badge. This runs
// for every notification that fires while the app is active.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as { type?: unknown; jobId?: unknown } | null;
    // Suppress the chatReply banner when useChat already rendered the
    // answer in-band - otherwise a foregrounded user sees the message in
    // the chat AND a redundant tray banner moments later.
    if (
      data &&
      typeof data === 'object' &&
      data.type === 'chatReply' &&
      typeof data.jobId === 'string' &&
      isChatJobAcknowledged(data.jobId)
    ) {
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
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

// Track notification-request identifiers we've already dispatched so the
// cold-start path (getLastNotificationResponseAsync) and the live listener
// don't fire onTap twice for the same tap. Module-level so it survives
// re-mounts within a single JS VM session - which is what we want, the
// risk we're guarding against is delivering ONE notification's payload
// twice to the same router.
const dispatchedNotificationIds = new Set<string>();

function dispatchPayload(
  response: Notifications.NotificationResponse,
  onTap: (payload: NotificationPayload) => void,
): void {
  const id = response.notification.request.identifier;
  if (dispatchedNotificationIds.has(id)) return;
  dispatchedNotificationIds.add(id);
  // Cap the set so it can't grow unbounded across long sessions. 200 is
  // way more than any user will ever bank in a single session.
  if (dispatchedNotificationIds.size > 200) {
    const first = dispatchedNotificationIds.values().next().value;
    if (first !== undefined) dispatchedNotificationIds.delete(first);
  }

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
  } else if (payload.type === 'newMail') {
    const p = payload as {
      provider?: unknown;
      messageId?: unknown;
      threadId?: unknown;
    };
    if (
      (p.provider === 'google' || p.provider === 'microsoft') &&
      typeof p.messageId === 'string'
    ) {
      onTap({
        type: 'newMail',
        provider: p.provider,
        messageId: p.messageId,
        threadId: typeof p.threadId === 'string' ? p.threadId : undefined,
      });
    }
  } else if (
    payload.type === 'brief' &&
    typeof (payload as { briefId?: unknown }).briefId === 'string'
  ) {
    onTap({ type: 'brief', briefId: (payload as { briefId: string }).briefId });
  } else if (
    payload.type === 'factDecay' &&
    typeof (payload as { factId?: unknown }).factId === 'string'
  ) {
    onTap({ type: 'factDecay', factId: (payload as { factId: string }).factId });
  } else if (
    payload.type === 'microsoftConsentGranted' &&
    typeof (payload as { tenantDomain?: unknown }).tenantDomain === 'string'
  ) {
    onTap({
      type: 'microsoftConsentGranted',
      tenantDomain: (payload as { tenantDomain: string }).tenantDomain,
    });
  } else if (
    payload.type === 'chatReply' &&
    typeof (payload as { jobId?: unknown }).jobId === 'string'
  ) {
    onTap({ type: 'chatReply', jobId: (payload as { jobId: string }).jobId });
  }
}

export function registerResponseHandler(
  onTap: (payload: NotificationPayload) => void,
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    dispatchPayload(response, onTap);
  });
  // Cold-start safety net: when the user taps a notification while the app
  // is fully killed, iOS launches the JS VM and the response is queued.
  // The live listener above MAY fire for that initial response, but in
  // practice (production builds, slow boot, multiple state transitions)
  // it sometimes doesn't - the response gets consumed by the system
  // before the listener attaches. getLastNotificationResponseAsync returns
  // that initial response explicitly. The dispatchedNotificationIds set
  // dedupes against the listener so we don't fire onTap twice.
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) dispatchPayload(response, onTap);
    })
    .catch((err) => {
      if (__DEV__) console.warn('[notifications] getLast failed:', err);
    });
  return () => sub.remove();
}

export async function scheduleReminderNotification(reminder: Reminder): Promise<void> {
  // SERVER-SIDE FIRE - no-op on client. The reminders-fire cron pushes
  // notifications via Expo. Stub kept through one release cycle for any
  // stale callers; remove in Phase 6 cleanup.
  void reminder;
}

export async function cancelReminderNotification(reminderId: string): Promise<void> {
  // Cancel both the one-shot reminder and any nudge slots scheduled for it.
  // Listing scheduled notifications is cheap and avoids tracking slot state.
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const prefix = `reminder:${reminderId}`;
    await Promise.all(
      scheduled
        .filter((s) => s.identifier === prefix || s.identifier.startsWith(`${prefix}:`))
        .map((s) =>
          Notifications.cancelScheduledNotificationAsync(s.identifier).catch(() => {}),
        ),
    );
  } catch {
    // ignore - best effort
  }
}

function reminderIdentifier(id: string): string {
  return `reminder:${id}`;
}

function nudgeIdentifier(id: string, hour: number): string {
  return `reminder:${id}:nudge:${hour}`;
}

// The local "God morgen / Dit overblik for i dag er klar" digest used to fire
// at 8am as a heads-up. It's been superseded by the server-side daily-brief
// edge function, which pushes the actual brief headline + first line at the
// user's configured morning-brief time. Running both produced two
// notifications back-to-back. We now only cancel any stale digest:* entries
// still queued from earlier installs - new ones are never scheduled.
export async function syncDailyDigest(): Promise<void> {
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const s of scheduled) {
      if (s.identifier.startsWith('digest:')) {
        try {
          await Notifications.cancelScheduledNotificationAsync(s.identifier);
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    if (__DEV__) console.warn('[notifications] cancel stale digests failed:', err);
  }
}

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
      void recordFeedEntry({
        id: `calendar:${event.id}:${fireAt.getTime()}`,
        type: 'calendarPreAlert',
        title: event.title,
        body: 'Starter om 15 minutter.',
        firesAt: fireAt,
        payload: { type: 'calendarPreAlert', eventId: event.id },
      });
    } catch (err) {
      if (__DEV__) console.warn('[notifications] schedule pre-alert failed:', err);
    }
  }
}

export async function syncOnAppForeground(): Promise<void> {
  await syncDailyDigest();
  const events = await fetchPreAlertEligibleEvents();
  await syncCalendarPreAlerts(events);
}
