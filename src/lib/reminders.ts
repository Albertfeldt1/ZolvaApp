// src/lib/reminders.ts
//
// Server-backed reminder store (public.reminders). Replaces the
// AsyncStorage-only memory-store reminder code. Uses supabase-js with
// the authenticated user's JWT — RLS policies enforce per-user
// isolation, so no extra server-side endpoints are needed for CRUD.

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
