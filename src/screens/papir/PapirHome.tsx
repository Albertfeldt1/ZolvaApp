import React, { useState, type ComponentType } from 'react';
import { ScrollView, View } from 'react-native';
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
  Card,
  IconButton,
  ListRow,
  PaperText,
  papirColor,
  papirRadius,
  papirShadow,
  papirSpace,
} from '../../design/papir';
import { useUser } from '../../lib/hooks';
import { greeting, formatToday } from '../../lib/date';
import { usePapirNav } from './nav';
import { WaveGlyph } from './WaveGlyph';

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

function SectionHeader({ label, action }: { label: string; action?: string }) {
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
        <PaperText role="small" color={papirColor.red}>
          {action}
        </PaperText>
      ) : null}
    </View>
  );
}

const RECORDINGS = [
  { title: 'Aflevering til Ole', sub: 'Mind mig om at ringe før frokost', dur: '0:24', bars: [5, 11, 7, 13, 6] },
  { title: 'Tilbud til Hansen', sub: 'Pris på terrasse, send inden fredag', dur: '1:18', bars: [9, 5, 13, 8, 11] },
  { title: 'Idéer til Instagram', sub: 'Reels om hverdagskaos', dur: '0:30', bars: [6, 13, 9, 5, 12] },
];

const TASKS = [
  { title: 'Aflever 2 dyr til Ole', time: '13.55', done: false },
  { title: 'Send tilbud til Hansen', time: 'før 16', done: false },
  { title: 'Bekræft møde med Sofie', time: '07.30', done: true },
];

function TaskRow({ title, time, done: initialDone }: { title: string; time: string; done: boolean }) {
  const [done, setDone] = useState(initialDone);
  return (
    <ScaleButton
      scaleTo={0.99}
      haptic="selection"
      onPress={() => setDone((d) => !d)}
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
        {title}
      </PaperText>
      <PaperText role="caption" color={done ? papirColor.ink4 : papirColor.red} tabular>
        {time}
      </PaperText>
    </ScaleButton>
  );
}

export function PapirHome() {
  const nav = usePapirNav();
  const { data: user } = useUser();
  const now = new Date();
  const d = formatToday(now);
  // Match the prototype's eyebrow style: "Tirsdag · 11. juni".
  const eyebrow = `${d.weekdayFull} · ${d.day}. ${d.monthFull}`;
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? '';
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingTop: 60, paddingBottom: 120 }}
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
            {greeting(now)},{firstName ? `\n${firstName}.` : '.'}
          </PaperText>
        </View>
        <IconButton accessibilityLabel="Søg" onPress={() => nav.push('search')}>
          <Search size={18} color={papirColor.ink} strokeWidth={1.8} />
        </IconButton>
      </View>

      <PaperText role="body" color={papirColor.ink2} style={{ marginTop: 12, paddingHorizontal: papirSpace.screen, maxWidth: 320 }}>
        Du har{' '}
        <PaperText role="bodyStrong" color={papirColor.ink}>
          1 møde
        </PaperText>{' '}
        og{' '}
        <PaperText role="bodyStrong" color={papirColor.ink}>
          9 nye mails
        </PaperText>
        .{' '}
        <PaperText role="bodyStrong" color={papirColor.ink}>
          3 af dem
        </PaperText>{' '}
        haster, så dem tager vi først.
      </PaperText>

      {/* Quick actions */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingHorizontal: papirSpace.screen, paddingTop: papirSpace.xl }}
      >
        <QuickButton Icon={AlignLeft} label="Briefing" onPress={() => nav.push('briefing')} />
        <QuickButton Icon={FileText} label="Noter" />
        <QuickButton Icon={MessageSquare} label="Chat" onPress={() => nav.push('chat')} />
        <QuickButton Icon={Search} label="Søg" onPress={() => nav.push('search')} />
      </ScrollView>

      {/* In focus: morning briefing card (dark surface) */}
      <SectionHeader label="I fokus" />
      <ScaleButton
        scaleTo={0.985}
        haptic="light"
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
      <SectionHeader label="Seneste optagelser" action="Alle" />
      {RECORDINGS.map((r, i) => (
        <View key={r.title}>
          <ListRow
            leading={<WaveGlyph heights={r.bars} color={papirColor.ink2} />}
            title={r.title}
            subtitle={r.sub}
            trailing={r.dur}
          />
          {i < RECORDINGS.length - 1 ? (
            <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
          ) : null}
        </View>
      ))}

      {/* Tasks today */}
      <SectionHeader label="Opgaver i dag" action="Se plan" />
      {TASKS.map((t) => (
        <TaskRow key={t.title} title={t.title} time={t.time} done={t.done} />
      ))}
    </ScrollView>
  );
}
