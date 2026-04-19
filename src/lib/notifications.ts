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

export async function syncDailyDigest(): Promise<void> {
  // filled in later
}

export async function syncCalendarPreAlerts(_events: never[]): Promise<void> {
  // filled in later
}

export async function syncOnAppForeground(): Promise<void> {
  // filled in later
}
