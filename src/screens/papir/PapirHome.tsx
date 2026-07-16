import React, { useCallback, useMemo, useState, type ComponentType } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { usePapirScreenPads } from './insets';
import {
  AlignLeft,
  ArrowRight,
  Bell,
  Check,
  Clock,
  FileText,
  Mail,
  MessageSquare,
  Search,
  Users,
} from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import {
  IconButton,
  ListRow,
  PaperText,
  papirColor,
  papirRadius,
  papirSpace,
} from '../../design/papir';
import { refreshCalendarNow, refreshMailNow, refreshRemindersNow, useInboxCounts, useNotes, useReminders, useUnreadNotificationCount, useUpcoming, useUser } from '../../lib/hooks';
import { useTodayBrief, type Brief } from '../../lib/briefs';
import { greeting, formatToday } from '../../lib/date';
import type { Note, Reminder, UpcomingEvent } from '../../lib/types';
import { usePapirNav } from './nav';
import { requestHistorySegment } from './PapirHistory';
import { requestPlanSegment } from './PapirPlan';
import { useNow } from './useNow';
import { useUndoableDone } from './useUndoableDone';
import { barsFor, WaveGlyph } from './WaveGlyph';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

function QuickButton({ Icon, label, onPress }: { Icon: IconCmp; label: string; onPress?: () => void }) {
  return (
    <ScaleButton
      scaleTo={0.97}
      haptic="light"
      onPress={onPress}
      style={{
        minWidth: 88,
        gap: 10,
        padding: 14,
        borderRadius: papirRadius.xl,
        borderWidth: 1,
        borderColor: papirColor.line,
        backgroundColor: papirColor.card,
      }}
    >
      <Icon size={20} color={papirColor.ink} strokeWidth={1.7} />
      {/* Cards size to their label — long ones ("Påmindelser") used to wrap
          mid-word in the old equal-width grid. */}
      <PaperText role="bodyStrong" style={{ fontSize: 13 }} numberOfLines={1}>
        {label}
      </PaperText>
    </ScaleButton>
  );
}

function SectionHeader({ label, action, onAction }: { label: string; action?: string; onAction?: () => void }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: papirSpace.screen,
        paddingTop: papirSpace.xxl,
        paddingBottom: papirSpace.md,
      }}
    >
      <PaperText role="eyebrow" color={papirColor.ink3}>
        {label}
      </PaperText>
      {action ? (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" accessibilityLabel={action} disabled={!onAction}>
          <PaperText role="small" color={papirColor.red}>
            {action}
          </PaperText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** "13.55"-style time label matching the prototype's Danish clock format. */
function clockLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Overdue tasks from earlier days must not masquerade as today (M6):
 * a bare "14.30" on yesterday's task reads as today 14.30. */
function taskTimeLabel(dueAt: Date | null, now: Date): string {
  if (!dueAt) return '';
  if (dueAt.toDateString() === now.toDateString()) return clockLabel(dueAt);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dueAt.toDateString() === y.toDateString()) return `i går ${clockLabel(dueAt)}`;
  return `${dueAt.getDate()}/${dueAt.getMonth() + 1} ${clockLabel(dueAt)}`;
}

function durationLabel(sec?: number): string {
  if (!sec || sec <= 0) return '';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// Server-composed day-tone → one quiet dot + word on the brief card (shared
// with PapirBriefing's header). Colors follow the token semantics: sage green
// for calm, rust (warm, never urgent) for busy — red stays reserved for the
// only tone that actually demands the user.
export const BRIEF_TONE: Record<NonNullable<Brief['tone']>, { label: string; color: string }> = {
  calm: { label: 'Rolig dag', color: papirColor.green },
  busy: { label: 'Travl dag', color: papirColor.rust },
  'heads-up': { label: 'Kræver dig', color: papirColor.red },
};

// "Din dag" ribbon colors — the approved design rotates the three category
// duos in order (purely aesthetic, no meaning): green → slate → rust.
const RIBBON_DUOS = [
  { color: papirColor.green, bg: papirColor.greenSoft },
  { color: papirColor.slate, bg: papirColor.slateSoft },
  { color: papirColor.rust, bg: papirColor.rustSoft },
] as const;

/** Horizontal ribbon of today's timed events. Renders nothing when the day
 * is meeting-free — the greeting already says "ingen møder". */
function DayRibbon({ events, onSeePlan }: { events: UpcomingEvent[]; onSeePlan: () => void }) {
  const timed = events
    .filter((e) => !e.allDay)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (timed.length === 0) return null;
  return (
    <>
      <SectionHeader label="Din dag" action="Se plan" onAction={onSeePlan} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingHorizontal: papirSpace.screen }}
      >
        {timed.map((e, i) => {
          const duo = RIBBON_DUOS[i % RIBBON_DUOS.length];
          return (
            <View
              key={e.id}
              style={{
                minWidth: 158,
                maxWidth: 220,
                backgroundColor: duo.bg,
                borderRadius: papirRadius.lg,
                paddingVertical: 14,
                paddingHorizontal: 16,
              }}
            >
              <PaperText role="small" color={duo.color} tabular>
                {clockLabel(e.start)}–{clockLabel(e.end)}
              </PaperText>
              <PaperText role="bodyStrong" style={{ fontSize: 14, marginTop: 5 }} numberOfLines={2}>
                {e.title}
              </PaperText>
            </View>
          );
        })}
      </ScrollView>
    </>
  );
}

function TaskRow({
  reminder,
  now,
  onDone,
  doneOverride,
}: {
  reminder: Reminder;
  now: Date;
  onDone: (id: string) => void;
  /** Visually done while the undo window is open (M7). */
  doneOverride?: boolean;
}) {
  const done = reminder.status === 'done' || !!doneOverride;
  return (
    <ScaleButton
      scaleTo={0.99}
      haptic="selection"
      onPress={done ? undefined : () => onDone(reminder.id)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingVertical: 14,
        paddingHorizontal: papirSpace.screen,
      }}
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
      <PaperText role="caption" color={done ? papirColor.ink4 : papirColor.red} tabular>
        {taskTimeLabel(reminder.dueAt, now)}
      </PaperText>
    </ScaleButton>
  );
}

/** Today's task list: pending due today/overdue first (by due time), then
 * reminders completed today — the visual "what I got done" tail. Returns the
 * total before capping so the header can say "Se plan (8)" (M8). */
function todaysTasks(reminders: Reminder[], now: Date): { shown: Reminder[]; total: number } {
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const pending = reminders
    .filter((r) => r.status === 'pending' && r.dueAt !== null && r.dueAt <= endOfDay)
    .sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
  const doneToday = reminders
    .filter((r) => r.status === 'done' && r.doneAt !== null && r.doneAt.toDateString() === now.toDateString())
    .sort((a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0));
  const all = [...pending, ...doneToday];
  return { shown: all.slice(0, 5), total: all.length };
}

export function PapirHome() {
  const nav = usePapirNav();
  const { data: user } = useUser();
  const upcoming = useUpcoming();
  const inbox = useInboxCounts();
  const notes = useNotes();
  const reminders = useReminders();
  const unreadNotifications = useUnreadNotificationCount();
  const { brief } = useTodayBrief();
  const toneMeta = brief?.tone ? BRIEF_TONE[brief.tone] : null;
  const now = useNow();
  const d = formatToday(now);
  // Match the prototype's eyebrow style: "Tirsdag · 11. juni".
  const eyebrow = `${d.weekdayFull} · ${d.day}. ${d.monthFull}`;
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? '';
  const pads = usePapirScreenPads();

  const recentRecordings = useMemo<Note[]>(
    () =>
      notes.data
        .filter((n) => n.source === 'voice')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 3),
    [notes.data],
  );

  const tasks = useMemo(() => todaysTasks(reminders.data, now), [reminders.data, now]);

  const statusError = !!upcoming.error;
  const statusReady = !upcoming.loading && !inbox.loading && !statusError;
  const meetings = upcoming.todayMeetingCount;
  const mails = inbox.unread;

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refreshMailNow();
    refreshCalendarNow();
    refreshRemindersNow();
    setTimeout(() => setRefreshing(false), 900);
  }, []);

  // Delayed-commit undo for the task checkboxes (M7).
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
      {/* Greeting */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          paddingHorizontal: papirSpace.screen,
        }}
      >
        <View>
          <PaperText role="eyebrow" color={papirColor.ink3}>
            {eyebrow}
          </PaperText>
          <PaperText role="displayL" style={{ marginTop: 14 }}>
            {greeting(now)}{firstName ? `,\n${firstName}.` : '.'}
          </PaperText>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View>
            <IconButton accessibilityLabel="Notifikationer" onPress={() => nav.push('notifications')}>
              <Bell size={18} color={papirColor.ink} strokeWidth={1.8} />
            </IconButton>
            {unreadNotifications > 0 ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: 1,
                  right: 1,
                  width: 9,
                  height: 9,
                  borderRadius: papirRadius.pill,
                  backgroundColor: papirColor.red,
                  borderWidth: 1.5,
                  borderColor: papirColor.paper,
                }}
              />
            ) : null}
          </View>
          <IconButton accessibilityLabel="Søg" onPress={() => nav.push('search')}>
            <Search size={18} color={papirColor.ink} strokeWidth={1.8} />
          </IconButton>
        </View>
      </View>

      {statusReady ? (
        // The status line names the day's mail but used to be dead text — the
        // only route to the inbox went THROUGH the briefing screen. Tapping
        // it is the direct path (mails > 0; with zero there's nothing to open).
        <Pressable
          onPress={mails > 0 ? () => nav.push('inbox') : undefined}
          disabled={mails === 0}
          accessibilityRole={mails > 0 ? 'button' : undefined}
          accessibilityLabel={mails > 0 ? 'Åbn indbakken' : undefined}
        >
          <PaperText role="body" color={papirColor.ink2} style={{ marginTop: 12, paddingHorizontal: papirSpace.screen, maxWidth: 320 }}>
            Du har{' '}
            <PaperText role="bodyStrong" color={papirColor.ink}>
              {meetings === 0 ? 'ingen møder' : meetings === 1 ? '1 møde' : `${meetings} møder`}
            </PaperText>{' '}
            og{' '}
            <PaperText role="bodyStrong" color={mails > 0 ? papirColor.red : papirColor.ink}>
              {mails === 0 ? 'ingen nye mails' : mails === 1 ? '1 ny mail' : `${mails} nye mails`}
            </PaperText>
            {' '}i dag.
          </PaperText>
        </Pressable>
      ) : statusError ? (
        <PaperText role="body" color={papirColor.ink3} style={{ marginTop: 12, paddingHorizontal: papirSpace.screen, maxWidth: 320 }}>
          Kunne ikke hente dit overblik. Træk ned for at prøve igen.
        </PaperText>
      ) : (
        <PaperText role="body" color={papirColor.ink3} style={{ marginTop: 12, paddingHorizontal: papirSpace.screen, maxWidth: 320 }}>
          Henter dit overblik…
        </PaperText>
      )}

      {/* Quick actions — horizontally swipeable (2026-07-07: Oscar wants ALL
          shortcuts kept, most important first, Søg last). With 6 cards the
          cut-off card at the screen edge IS the scroll affordance — the old
          "clipped card reads as a bug" concern only applied when everything
          was meant to fit. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ flexDirection: 'row', gap: 10, paddingHorizontal: papirSpace.screen }}
        style={{ marginTop: papirSpace.xl }}
      >
        <QuickButton Icon={AlignLeft} label="Briefing" onPress={() => nav.push('briefing')} />
        <QuickButton Icon={Mail} label="Indbakke" onPress={() => nav.push('inbox')} />
        <QuickButton
          Icon={Clock}
          label="Påmindelser"
          onPress={() => {
            requestPlanSegment(0);
            nav.setTab('plan', { slide: true });
          }}
        />
        <QuickButton Icon={MessageSquare} label="Chat" onPress={() => nav.push('chat')} />
        <QuickButton
          Icon={FileText}
          label="Noter"
          onPress={() => {
            requestHistorySegment(1);
            nav.setTab('history', { slide: true });
          }}
        />
        <QuickButton Icon={Users} label="Netværk" onPress={() => nav.push('network')} />
        <QuickButton Icon={Search} label="Søg" onPress={() => nav.push('search')} />
      </ScrollView>

      {/* In focus: briefing card (dark surface) — label follows the freshest brief's kind */}
      <SectionHeader label="I fokus" />
      <ScaleButton
        scaleTo={0.985}
        haptic="light"
        onPress={() => nav.push('briefing')}
        style={{
          marginHorizontal: papirSpace.screen,
          padding: 20,
          borderRadius: papirRadius.card,
          backgroundColor: papirColor.ink,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <PaperText role="caption" color={papirColor.ink4} style={{ letterSpacing: 2, textTransform: 'uppercase' }}>
            {brief
              ? brief.kind === 'midday'
                ? 'Middagsbriefing'
                : brief.kind === 'evening'
                  ? 'Aftenbriefing'
                  : 'Morgenbriefing'
              : 'Briefing'}
          </PaperText>
          {/* Tone signal: only the dot carries the hue (quiet on the dark
              card); the word stays in the same ink4 as the kind label. */}
          {toneMeta ? (
            <>
              <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: toneMeta.color }} />
              <PaperText role="caption" color={papirColor.ink4}>
                {toneMeta.label}
              </PaperText>
            </>
          ) : null}
        </View>
        <PaperText role="titleSerif" color={papirColor.onInk} style={{ fontSize: 22, marginTop: 10, maxWidth: 240 }}>
          {brief?.kind === 'midday'
            ? 'Status på din dag'
            : brief?.kind === 'evening'
              ? 'Din dag i morgen'
              : 'Din dag på 3 minutter'}
        </PaperText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <WaveGlyph heights={[6, 11, 8, 13]} color={papirColor.ink4} />
          <PaperText role="caption" color="#C9C4B6">
            {brief ? (brief.readAt ? '3 min · læst' : '3 min · klar nu') : 'kommer senere i dag'}
          </PaperText>
        </View>
        <View
          style={{
            position: 'absolute',
            right: 18,
            bottom: 18,
            width: 40,
            height: 40,
            borderRadius: 999,
            backgroundColor: 'rgba(255,255,255,0.12)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ArrowRight size={18} color={papirColor.onInk} strokeWidth={2} />
        </View>
      </ScaleButton>

      {/* Today's events — the approved design's color ribbon. "Se plan" on a
          row of events means the calendar, not the reminder list. */}
      <DayRibbon
        events={upcoming.todayEvents}
        onSeePlan={() => {
          requestPlanSegment(1);
          nav.setTab('plan', { slide: true });
        }}
      />

      {/* Recent recordings */}
      <SectionHeader
        label="Seneste optagelser"
        action="Alle"
        onAction={() => {
          requestHistorySegment(0);
          nav.setTab('history', { slide: true });
        }}
      />
      {recentRecordings.length === 0 ? (
        <PaperText role="body" color={papirColor.ink3} style={{ paddingHorizontal: papirSpace.screen }}>
          Ingen optagelser endnu — tryk på den røde knap for at starte.
        </PaperText>
      ) : (
        recentRecordings.map((r, i) => (
          <View key={r.id}>
            <ListRow
              leading={<WaveGlyph heights={barsFor(r.id)} color={papirColor.ink2} />}
              title={r.title ?? r.text.slice(0, 48)}
              subtitle={r.text.slice(0, 52)}
              trailing={durationLabel(r.durationSec)}
              onPress={() => nav.push('noteDetail', { id: r.id })}
            />
            {i < recentRecordings.length - 1 ? (
              <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
            ) : null}
          </View>
        ))
      )}

      {/* Reminders today */}
      <SectionHeader
        label="Påmindelser i dag"
        action={tasks.total > tasks.shown.length ? `Se alle (${tasks.total})` : 'Se alle'}
        onAction={() => {
          requestPlanSegment(0);
          nav.setTab('plan', { slide: true });
        }}
      />
      {tasks.shown.length === 0 ? (
        <PaperText role="body" color={papirColor.ink3} style={{ paddingHorizontal: papirSpace.screen }}>
          Ingen påmindelser i dag.
        </PaperText>
      ) : (
        tasks.shown.map((t) => (
          <TaskRow
            key={t.id}
            reminder={t}
            now={now}
            onDone={undoable.markDone}
            doneOverride={undoable.pendingDoneIds.has(t.id)}
          />
        ))
      )}
    </ScrollView>
    {undoable.snackbar}
    </View>
  );
}
