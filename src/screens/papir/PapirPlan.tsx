import React, { useCallback, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { PaperText, SegmentedControl, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { refreshCalendarNow, useDayEvents, useReminders } from '../../lib/hooks';
import type { Reminder } from '../../lib/types';
import { usePapirScreenPads } from './insets';
import { useNow } from './useNow';
import { useUndoableDone } from './useUndoableDone';
import { DayTimeline, type TimelineEvent } from './DayTimeline';
import { PapirLoader } from './PapirLoader';

const WEEKDAY_LETTER = ['S', 'M', 'T', 'O', 'T', 'F', 'L'];
const WEEKDAYS_SHORT = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];

function GroupLabel({ children }: { children: string }) {
  return (
    <PaperText
      role="eyebrow"
      color={papirColor.ink3}
      style={{ paddingHorizontal: papirSpace.screen, paddingTop: papirSpace.xl, paddingBottom: papirSpace.sm }}
    >
      {children}
    </PaperText>
  );
}

function clockLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Due label per group: clock today, weekday within a week, date beyond. */
function dueLabel(r: Reminder, now: Date): { text: string; muted: boolean } {
  if (r.status === 'done') {
    const d = r.doneAt ?? r.createdAt;
    const sameDay = d.toDateString() === now.toDateString();
    return { text: sameDay ? clockLabel(d) : WEEKDAYS_SHORT[d.getDay()], muted: true };
  }
  if (!r.dueAt) return { text: 'når du kan', muted: true };
  const sameDay = r.dueAt.toDateString() === now.toDateString();
  if (sameDay) return { text: clockLabel(r.dueAt), muted: false };
  // Overdue from an earlier day: a weekday label ("fre") would read as the
  // COMING Friday (M6). Say it plainly instead.
  if (r.dueAt < now) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (r.dueAt.toDateString() === y.toDateString()) return { text: `i går ${clockLabel(r.dueAt)}`, muted: false };
    return { text: `${r.dueAt.getDate()}/${r.dueAt.getMonth() + 1}`, muted: false };
  }
  const days = Math.round((r.dueAt.getTime() - now.getTime()) / 86_400_000);
  if (days < 7) return { text: WEEKDAYS_SHORT[r.dueAt.getDay()], muted: true };
  return { text: `${r.dueAt.getDate()}/${r.dueAt.getMonth() + 1}`, muted: true };
}

function TaskRow({
  reminder,
  now,
  onDone,
  onRemove,
  doneOverride,
}: {
  reminder: Reminder;
  now: Date;
  onDone: (id: string) => void;
  onRemove: (r: Reminder) => void;
  /** Visually done while the undo window is open (M7). */
  doneOverride?: boolean;
}) {
  const done = reminder.status === 'done' || !!doneOverride;
  const label = dueLabel(reminder, now);
  return (
    <ScaleButton
      scaleTo={0.99}
      haptic="selection"
      onPress={done ? undefined : () => onDone(reminder.id)}
      onLongPress={() => onRemove(reminder)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: papirSpace.screen }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 999,
          borderWidth: 1.6,
          borderColor: done ? papirColor.ink : papirColor.ink3,
          backgroundColor: done ? papirColor.ink : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {done ? <Check size={12} color="#FFFFFF" strokeWidth={2.6} /> : null}
      </View>
      <PaperText
        role="body"
        color={done ? papirColor.ink4 : papirColor.ink}
        style={{ flex: 1, textDecorationLine: done ? 'line-through' : 'none' }}
      >
        {reminder.text}
      </PaperText>
      <PaperText role="caption" color={done ? papirColor.ink4 : label.muted ? papirColor.ink3 : papirColor.red} tabular>
        {label.text}
      </PaperText>
    </ScaleButton>
  );
}

function TasksView({
  reminders,
  undoable,
}: {
  reminders: ReturnType<typeof useReminders>;
  undoable: ReturnType<typeof useUndoableDone>;
}) {
  const now = useNow();

  const groups = useMemo(() => {
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const pending = reminders.data.filter((r) => r.status === 'pending');
    const today = pending
      .filter((r) => r.dueAt === null || r.dueAt <= endOfDay)
      .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));
    const upcoming = pending
      .filter((r) => r.dueAt !== null && r.dueAt > endOfDay)
      .sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
    const done = reminders.data
      .filter((r) => r.status === 'done')
      .sort((a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0))
      .slice(0, 10);
    return [
      { label: 'I dag', items: today },
      { label: 'Kommende', items: upcoming },
      { label: 'Klaret', items: done },
    ].filter((g) => g.items.length > 0);
  }, [reminders.data, now]);

  const confirmRemove = (r: Reminder) => {
    Alert.alert('Slet opgave', `Slet "${r.text}"?`, [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Slet', style: 'destructive', onPress: () => void reminders.remove(r.id) },
    ]);
  };

  if (reminders.loading && reminders.data.length === 0) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 60 }}>
        <PapirLoader />
      </View>
    );
  }

  if (groups.length === 0) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 60, paddingHorizontal: papirSpace.screen, gap: 8 }}>
        <PaperText role="bodyStrong" color={papirColor.ink2}>
          Ingen opgaver
        </PaperText>
        <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center' }}>
          Tryk på den røde knap og sig &ldquo;husk at…&rdquo; — eller bed chatten. Opgaverne samles her.
        </PaperText>
      </View>
    );
  }

  return (
    <View>
      {groups.map((g) => (
        <View key={g.label}>
          <GroupLabel>{g.label}</GroupLabel>
          {g.items.map((r) => (
            <TaskRow
              key={r.id}
              reminder={r}
              now={now}
              onDone={undoable.markDone}
              onRemove={confirmRemove}
              doneOverride={undoable.pendingDoneIds.has(r.id)}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

/** The 7 days starting today — index 0 is always "i dag". */
function weekDays(now: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    return d;
  });
}

function CalendarView() {
  const now = useNow();
  // Rebuild the strip when the DAY changes (not every minute-tick).
  const dayKey = now.toDateString();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const days = useMemo(() => weekDays(now), [dayKey]);
  const [sel, setSel] = useState(0);
  const selectedDay = days[sel];
  const isToday = sel === 0;
  const { data: events, loading, error } = useDayEvents(selectedDay);

  const allDay = events.filter((e) => e.allDay);
  const timed = events.filter((e) => !e.allDay);

  const timelineEvents: TimelineEvent[] = timed.map((e) => {
    const start = e.start.getHours() + e.start.getMinutes() / 60;
    // Events crossing midnight get capped at 24 so they render to the bottom
    // of the day instead of "ending before they start".
    const sameDay = e.end.toDateString() === e.start.toDateString();
    const end = sameDay ? e.end.getHours() + e.end.getMinutes() / 60 : 24;
    return { id: e.id, start, end: Math.max(end, start + 0.25), title: e.title, place: e.location };
  });

  // Expand the visible window so early/late events keep a home (M86).
  let startHour = 7;
  let endHour = 22;
  timelineEvents.forEach((e) => {
    startHour = Math.min(startHour, Math.floor(e.start));
    endHour = Math.max(endHour, Math.ceil(e.end ?? e.start + 1));
  });

  return (
    <View style={{ marginTop: papirSpace.base }}>
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: papirSpace.screen }}>
        {days.map((day, i) => {
          const on = i === sel;
          return (
            <ScaleButton
              key={day.toISOString()}
              scaleTo={0.95}
              haptic="selection"
              onPress={() => setSel(i)}
              style={{
                flex: 1,
                alignItems: 'center',
                paddingVertical: 10,
                borderRadius: papirRadius.md,
                backgroundColor: on ? papirColor.ink : 'transparent',
              }}
            >
              <PaperText role="caption" color={on ? papirColor.ink4 : papirColor.ink3}>
                {WEEKDAY_LETTER[day.getDay()]}
              </PaperText>
              <PaperText role="bodyStrong" color={on ? papirColor.onInk : papirColor.ink} style={{ marginTop: 5 }}>
                {String(day.getDate())}
              </PaperText>
            </ScaleButton>
          );
        })}
      </View>

      {allDay.length > 0 ? (
        <View style={{ paddingHorizontal: papirSpace.screen, marginTop: papirSpace.base, gap: 6 }}>
          {allDay.map((e) => (
            <View
              key={e.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                backgroundColor: papirColor.paper2,
                borderRadius: papirRadius.md,
                paddingVertical: 8,
                paddingHorizontal: 12,
              }}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: papirColor.red }} />
              <PaperText role="small" color={papirColor.ink2} style={{ flex: 1 }}>
                {e.title}
              </PaperText>
              <PaperText role="caption" color={papirColor.ink3}>
                Hele dagen
              </PaperText>
            </View>
          ))}
        </View>
      ) : null}

      {loading && events.length === 0 ? (
        <View style={{ alignItems: 'center', paddingTop: 60 }}>
          <PapirLoader />
        </View>
      ) : error ? (
        <PaperText role="body" color={papirColor.ink3} style={{ paddingHorizontal: papirSpace.screen, paddingTop: 40, textAlign: 'center' }}>
          Kalenderen kunne ikke hentes. Tjek din forbindelse.
        </PaperText>
      ) : (
        <View style={{ marginTop: papirSpace.lg, paddingLeft: papirSpace.screen }}>
          <DayTimeline events={timelineEvents} startHour={startHour} endHour={endHour} showNow={isToday} />
          {/* An empty grid is ambiguous — say it plainly (QA L9). Floats as a
              centered pill OVER the quiet grid; inline flow collided with the
              absolutely-positioned hour rows. */}
          {timelineEvents.length === 0 && allDay.length === 0 ? (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', paddingLeft: papirSpace.screen }]}
            >
              <View
                style={{
                  backgroundColor: papirColor.card,
                  borderWidth: 1,
                  borderColor: papirColor.line,
                  borderRadius: papirRadius.pill,
                  paddingVertical: 10,
                  paddingHorizontal: 18,
                }}
              >
                <PaperText role="body" color={papirColor.ink3}>
                  {isToday ? 'Ingen begivenheder i dag — dagen er din.' : 'Ingen begivenheder denne dag.'}
                </PaperText>
              </View>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

export function PapirPlan() {
  const [view, setView] = useState(0);
  const pads = usePapirScreenPads();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refreshCalendarNow();
    setTimeout(() => setRefreshing(false), 900);
  }, []);
  // Reminders + undo live HERE (not in TasksView): the snackbar must sit
  // outside the ScrollView or it would scroll away with the content (M7).
  const reminders = useReminders();
  const commitDone = useCallback((id: string) => void reminders.markDone(id), [reminders.markDone]);
  const undoable = useUndoableDone(commitDone);
  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingTop: pads.top, paddingBottom: pads.bottom }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={papirColor.red} />}
    >
      <View style={{ paddingHorizontal: papirSpace.screen }}>
        <PaperText role="eyebrow" color={papirColor.ink3}>
          Hold styr på dagen
        </PaperText>
        <PaperText role="displayM" style={{ marginTop: 8 }}>
          Plan
        </PaperText>
      </View>
      <View style={{ paddingHorizontal: papirSpace.screen, marginTop: 14 }}>
        <SegmentedControl options={['Opgaver', 'Kalender']} value={view} onChange={setView} />
      </View>
      {view === 0 ? <TasksView reminders={reminders} undoable={undoable} /> : <CalendarView />}
    </ScrollView>
    {undoable.snackbar}
    </View>
  );
}
