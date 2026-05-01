// src/lib/reminders.ts
//
// Server-backed reminder store (public.reminders). Replaces the
// AsyncStorage-only memory-store reminder code. Uses supabase-js with
// the authenticated user's JWT — RLS policies enforce per-user
// isolation, so no extra server-side endpoints are needed for CRUD.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { supabase } from './supabase';
import type { Reminder } from './types';

const TABLE = 'reminders';
const PAST_DUE_GRACE_MS = 5 * 60 * 1000;

type Row = {
  id: string;
  user_id: string;
  title: string;
  due_at: string;
  completed: boolean;
  created_at: string;
  fired_at: string | null;
  scheduled_for_tz: string | null;
};

function rowToReminder(row: Row): Reminder {
  return {
    id: row.id,
    text: row.title,
    dueAt: row.due_at ? new Date(row.due_at) : null,
    status: row.completed ? 'done' : 'pending',
    createdAt: new Date(row.created_at),
    doneAt: row.completed ? new Date(row.created_at) : null,
    firedAt: row.fired_at ? new Date(row.fired_at) : null,
    scheduledForTz: row.scheduled_for_tz ?? null,
  };
}

export async function listAllReminders(userId: string): Promise<Reminder[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('due_at', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []).map((r) => rowToReminder(r as Row));
}

export async function addReminder(
  userId: string,
  text: string,
  dueAt: Date | null,
  tz: string | null,
): Promise<Reminder> {
  if (!text.trim()) throw new Error('addReminder: empty text');
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      title: text.trim(),
      due_at: (dueAt ?? new Date('2099-12-31T00:00:00Z')).toISOString(),
      scheduled_for_tz: tz,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToReminder(data as Row);
}

export async function markReminderDone(id: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ completed: true })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteReminder(id: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', id);
  if (error) throw error;
}

export function isPendingAndDueOrUpcoming(r: Reminder, now: Date): boolean {
  if (r.status === 'done') return false;
  if (r.dueAt && r.dueAt.getTime() < now.getTime() - PAST_DUE_GRACE_MS) return false;
  return true;
}

export function formatReminderForListTool(r: Reminder): string {
  const due = r.dueAt ? r.dueAt.toISOString() : 'ingen tid';
  return `${r.id} [${r.status}] ${due}: ${r.text}`;
}

const REMINDERS_LEGACY_KEY = (uid: string) => `zolva.${uid}.memory.reminders`;
const MIGRATION_FLAG = (uid: string) => `zolva.${uid}.migration.reminders-server.v1`;
// Separate flag from MIGRATION_FLAG so users who already migrated in v1 (and
// thus have stale `reminder:*` entries lingering in iOS Notification Center)
// still get the one-time sweep on next launch.
const LEGACY_NOTIF_SWEEP_FLAG = (uid: string) =>
  `zolva.${uid}.cleanup.legacy-reminder-notifs.v1`;

export async function migrateLocalRemindersToServer(userId: string): Promise<void> {
  if (!userId) return;
  const flag = await AsyncStorage.getItem(MIGRATION_FLAG(userId));
  if (!flag) {
    try {
      const raw = await AsyncStorage.getItem(REMINDERS_LEGACY_KEY(userId));
      if (raw) {
        const parsed = JSON.parse(raw) as Array<{
          id: string; text: string; dueAt?: string; status?: 'pending' | 'done'; createdAt?: string;
        }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const rows = parsed
            .filter((r) => r.status !== 'done')
            .map((r) => ({
              user_id: userId,
              title: r.text,
              due_at: r.dueAt
                ? new Date(r.dueAt).toISOString()
                : new Date('2099-12-31T00:00:00Z').toISOString(),
            }));
          if (rows.length > 0) {
            await supabase.from(TABLE).insert(rows);
          }
        }
        await AsyncStorage.removeItem(REMINDERS_LEGACY_KEY(userId));
      }
      await AsyncStorage.setItem(MIGRATION_FLAG(userId), '1');
    } catch (err) {
      if (__DEV__) console.warn('[reminders] migration failed:', err);
    }
  }

  // Sweep stale iOS-scheduled `reminder:*` notifications left over from
  // the pre-server-firing client. The OLD scheduleReminderNotification
  // queued one notification at due_at plus nudges at later hours
  // (`reminder:<id>:nudge:<hour>`); the v1 migration ported the data
  // server-side but never cancelled these, so users got the server push
  // AND every queued iOS fire long after the reminder had already fired.
  // Safe sweep — no current code path schedules `reminder:*` identifiers.
  await sweepLegacyReminderNotifications(userId);
}

async function sweepLegacyReminderNotifications(userId: string): Promise<void> {
  const flag = await AsyncStorage.getItem(LEGACY_NOTIF_SWEEP_FLAG(userId)).catch(() => null);
  if (flag) return;
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const stale = scheduled.filter((s) => s.identifier.startsWith('reminder:'));
    await Promise.all(
      stale.map((s) =>
        Notifications.cancelScheduledNotificationAsync(s.identifier).catch(() => {}),
      ),
    );
    await AsyncStorage.setItem(LEGACY_NOTIF_SWEEP_FLAG(userId), '1');
    if (__DEV__ && stale.length > 0) {
      console.log(`[reminders] swept ${stale.length} stale iOS reminder notifications`);
    }
  } catch (err) {
    if (__DEV__) console.warn('[reminders] legacy notif sweep failed:', err);
  }
}
