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
