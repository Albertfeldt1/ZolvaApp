import React, { useMemo, type ComponentType } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { usePapirScreenPads } from './insets';
import {
  AlignLeft,
  ArrowRight,
  Check,
  FileText,
  MessageSquare,
  Search,
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
import { useInboxCounts, useNotes, useReminders, useUpcoming, useUser } from '../../lib/hooks';
import { greeting, formatToday } from '../../lib/date';
import type { Note, Reminder } from '../../lib/types';
import { usePapirNav } from './nav';
import { barsFor, WaveGlyph } from './WaveGlyph';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

function QuickButton({ Icon, label, onPress }: { Icon: IconCmp; label: string; onPress?: () => void }) {
  return (
    <ScaleButton
      scaleTo={0.97}
      haptic="light"
      onPress={onPress}
      style={{
        width: 88,
        gap: 10,
        padding: 14,
        borderRadius: papirRadius.xl,
        borderWidth: 1,
        borderColor: papirColor.line,
        backgroundColor: papirColor.card,
      }}
    >
      <Icon size={20} color={papirColor.ink} strokeWidth={1.7} />
      <PaperText role="bodyStrong" style={{ fontSize: 13 }}>
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

function durationLabel(sec?: number): string {
  if (!sec || sec <= 0) return '';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function TaskRow({ reminder, onDone }: { reminder: Reminder; onDone: (id: string) => void }) {
  const done = reminder.status === 'done';
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
        {reminder.dueAt ? clockLabel(reminder.dueAt) : ''}
      </PaperText>
    </ScaleButton>
  );
}

/** Today's task list: pending due today/overdue first (by due time), then
 * reminders completed today — the visual "what I got done" tail. */
function todaysTasks(reminders: Reminder[], now: Date): Reminder[] {
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const pending = reminders
    .filter((r) => r.status === 'pending' && r.dueAt !== null && r.dueAt <= endOfDay)
    .sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
  const doneToday = reminders
    .filter((r) => r.status === 'done' && r.doneAt !== null && r.doneAt.toDateString() === now.toDateString())
    .sort((a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0));
  return [...pending, ...doneToday].slice(0, 5);
}

export function PapirHome() {
  const nav = usePapirNav();
  const { data: user } = useUser();
  const upcoming = useUpcoming();
  const inbox = useInboxCounts();
  const notes = useNotes();
  const reminders = useReminders();
  const now = new Date();
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

  const statusReady = !upcoming.loading && !inbox.loading;
  const meetings = upcoming.todayMeetingCount;
  const mails = inbox.unread;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingTop: pads.top, paddingBottom: pads.bottom }}
      showsVerticalScrollIndicator={false}
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
        <IconButton accessibilityLabel="Søg" onPress={() => nav.push('search')}>
          <Search size={18} color={papirColor.ink} strokeWidth={1.8} />
        </IconButton>
      </View>

      {statusReady ? (
        <PaperText role="body" color={papirColor.ink2} style={{ marginTop: 12, paddingHorizontal: papirSpace.screen, maxWidth: 320 }}>
          Du har{' '}
          <PaperText role="bodyStrong" color={papirColor.ink}>
            {meetings === 0 ? 'ingen møder' : meetings === 1 ? '1 møde' : `${meetings} møder`}
          </PaperText>{' '}
          og{' '}
          <PaperText role="bodyStrong" color={papirColor.ink}>
            {mails === 0 ? 'ingen nye mails' : mails === 1 ? '1 ny mail' : `${mails} nye mails`}
          </PaperText>
          {' '}i dag.
        </PaperText>
      ) : (
        <PaperText role="body" color={papirColor.ink3} style={{ marginTop: 12, paddingHorizontal: papirSpace.screen, maxWidth: 320 }}>
          Henter dit overblik…
        </PaperText>
      )}

      {/* Quick actions */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingHorizontal: papirSpace.screen, paddingTop: papirSpace.xl }}
      >
        <QuickButton Icon={AlignLeft} label="Briefing" onPress={() => nav.push('briefing')} />
        <QuickButton Icon={FileText} label="Noter" onPress={() => nav.setTab('history')} />
        <QuickButton Icon={MessageSquare} label="Chat" onPress={() => nav.push('chat')} />
        <QuickButton Icon={Search} label="Søg" onPress={() => nav.push('search')} />
      </ScrollView>

      {/* In focus: morning briefing card (dark surface) */}
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
        <PaperText role="caption" color={papirColor.ink4} style={{ letterSpacing: 2, textTransform: 'uppercase' }}>
          Morgenbriefing
        </PaperText>
        <PaperText role="titleSerif" color={papirColor.onInk} style={{ fontSize: 22, marginTop: 10, maxWidth: 240 }}>
          Din dag på 3 minutter
        </PaperText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <WaveGlyph heights={[6, 11, 8, 13]} color={papirColor.ink4} />
          <PaperText role="caption" color="#C9C4B6">
            3 min · klar nu
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

      {/* Recent recordings */}
      <SectionHeader label="Seneste optagelser" action="Alle" onAction={() => nav.setTab('history')} />
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
            />
            {i < recentRecordings.length - 1 ? (
              <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
            ) : null}
          </View>
        ))
      )}

      {/* Tasks today */}
      <SectionHeader label="Opgaver i dag" action="Se plan" onAction={() => nav.setTab('plan')} />
      {tasks.length === 0 ? (
        <PaperText role="body" color={papirColor.ink3} style={{ paddingHorizontal: papirSpace.screen }}>
          Ingen opgaver i dag.
        </PaperText>
      ) : (
        tasks.map((t) => <TaskRow key={t.id} reminder={t} onDone={(id) => void reminders.markDone(id)} />)
      )}
    </ScrollView>
  );
}
