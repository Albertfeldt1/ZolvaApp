import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { PaperText, SegmentedControl, papirColor, papirRadius, papirSpace } from '../../design/papir';

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

function TaskRow({ title, time, done: initial, muted }: { title: string; time: string; done?: boolean; muted?: boolean }) {
  const [done, setDone] = useState(!!initial);
  return (
    <ScaleButton
      scaleTo={0.99}
      haptic="selection"
      onPress={() => setDone((d) => !d)}
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
        {title}
      </PaperText>
      <PaperText role="caption" color={done ? papirColor.ink4 : muted ? papirColor.ink3 : papirColor.red} tabular>
        {time}
      </PaperText>
    </ScaleButton>
  );
}

const TASK_GROUPS = [
  { label: 'I dag', items: [
    { title: 'Aflever 2 dyr til Ole', time: '13.55' },
    { title: 'Send tilbud til Hansen', time: 'før 16' },
    { title: 'Ring til revisor om bilag', time: 'når du kan', muted: true },
  ] },
  { label: 'Kommende', items: [
    { title: 'Forbered Instagram-uge', time: 'tor', muted: true },
    { title: 'Book frisør', time: 'fre', muted: true },
  ] },
  { label: 'Klaret', items: [
    { title: 'Bekræft møde med Sofie', time: '07.30', done: true },
    { title: 'Betal faktura til leverandør', time: 'i går', done: true },
  ] },
];

function TasksView() {
  return (
    <View>
      {TASK_GROUPS.map((g) => (
        <View key={g.label}>
          <GroupLabel>{g.label}</GroupLabel>
          {g.items.map((it) => (
            <TaskRow key={it.title} title={it.title} time={it.time} done={'done' in it ? it.done : false} muted={'muted' in it ? it.muted : false} />
          ))}
        </View>
      ))}
    </View>
  );
}

const WEEK = [
  { wn: 'M', d: 10 },
  { wn: 'T', d: 11 },
  { wn: 'O', d: 12 },
  { wn: 'T', d: 13 },
  { wn: 'F', d: 14 },
  { wn: 'L', d: 15 },
  { wn: 'S', d: 16 },
];

const EVENTS = [
  { time: '11.00', title: 'Kundemøde hos Hansen', place: 'Hovedgaden 12' },
  { time: '13.55', title: 'Aflever 2 dyr til Ole', place: 'Gården' },
  { time: '16.30', title: 'Opkald med revisor', place: 'Telefon' },
];

function CalendarView() {
  const [sel, setSel] = useState(1);
  return (
    <View style={{ marginTop: papirSpace.base }}>
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: papirSpace.screen }}>
        {WEEK.map((w, i) => {
          const on = i === sel;
          return (
            <ScaleButton
              key={w.d}
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
                {w.wn}
              </PaperText>
              <PaperText role="bodyStrong" color={on ? papirColor.onInk : papirColor.ink} style={{ marginTop: 5 }}>
                {String(w.d)}
              </PaperText>
            </ScaleButton>
          );
        })}
      </View>
      <View style={{ marginTop: papirSpace.lg }}>
        {EVENTS.map((e) => (
          <View key={e.time} style={{ flexDirection: 'row', gap: 14, paddingHorizontal: papirSpace.screen, paddingVertical: 8 }}>
            <PaperText role="small" color={papirColor.ink3} tabular style={{ width: 42, paddingTop: 12 }}>
              {e.time}
            </PaperText>
            <View
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: papirColor.line,
                borderLeftWidth: 3,
                borderLeftColor: papirColor.red,
                borderRadius: 13,
                backgroundColor: papirColor.card,
                padding: 12,
              }}
            >
              <PaperText role="bodyStrong">{e.title}</PaperText>
              <PaperText role="caption" color={papirColor.ink2} style={{ marginTop: 3 }}>
                {e.place}
              </PaperText>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

export function PapirPlan() {
  const [view, setView] = useState(0);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingTop: 60, paddingBottom: 120 }}
      showsVerticalScrollIndicator={false}
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
      {view === 0 ? <TasksView /> : <CalendarView />}
    </ScrollView>
  );
}
