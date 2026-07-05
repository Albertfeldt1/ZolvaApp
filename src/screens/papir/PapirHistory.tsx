import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { FileText } from 'lucide-react-native';
import { ListRow, PaperText, SegmentedControl, papirColor, papirSpace } from '../../design/papir';
import { useNotes } from '../../lib/hooks';
import type { Note } from '../../lib/types';
import { usePapirScreenPads } from './insets';
import { WaveGlyph } from './WaveGlyph';

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

/** Deterministic pseudo-waveform per note so rows stay visually distinct
 * without storing audio (transcript-only by design). */
function barsFor(id: string): number[] {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return Array.from({ length: 5 }, (_, i) => 5 + ((h >> (i * 5)) % 9));
}

const WEEKDAYS_SHORT = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];

function trailingFor(note: Note, now: Date): string {
  const d = note.createdAt;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (daysAgo < 7) return WEEKDAYS_SHORT[d.getDay()];
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function durationLabel(sec?: number): string | null {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')} min` : `${s} sek`;
}

type Group = { label: string; items: Note[] };

function groupByDay(notes: Note[], now: Date): Group[] {
  const today: Note[] = [];
  const yesterday: Note[] = [];
  const earlier: Note[] = [];
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  notes.forEach((n) => {
    const ds = n.createdAt.toDateString();
    if (ds === now.toDateString()) today.push(n);
    else if (ds === y.toDateString()) yesterday.push(n);
    else earlier.push(n);
  });
  return [
    { label: 'I dag', items: today },
    { label: 'I går', items: yesterday },
    { label: 'Tidligere', items: earlier },
  ].filter((g) => g.items.length > 0);
}

export function PapirHistory() {
  const pads = usePapirScreenPads();
  const notes = useNotes();
  const [segment, setSegment] = useState(0);
  const now = new Date();

  const shown = useMemo(() => {
    const wantVoice = segment === 0;
    const filtered = notes.data.filter((n) => (n.source === 'voice') === wantVoice);
    // Newest first — the store appends chronologically.
    return [...filtered].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [notes.data, segment]);

  const groups = useMemo(() => groupByDay(shown, now), [shown, now]);

  const confirmDelete = (note: Note) => {
    Alert.alert('Slet', `Slet "${note.title ?? note.text.slice(0, 40)}"?`, [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Slet', style: 'destructive', onPress: () => notes.remove(note.id) },
    ]);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingTop: pads.top, paddingBottom: pads.bottom }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ paddingHorizontal: papirSpace.screen }}>
        <PaperText role="eyebrow" color={papirColor.ink3}>
          Alt du har sagt
        </PaperText>
        <PaperText role="displayM" style={{ marginTop: 8 }}>
          Historik
        </PaperText>
        <View style={{ marginTop: 18 }}>
          <SegmentedControl options={['Optagelser', 'Noter']} value={segment} onChange={setSegment} />
        </View>
      </View>

      {groups.length === 0 ? (
        <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            {segment === 0 ? 'Ingen optagelser endnu' : 'Ingen noter endnu'}
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center' }}>
            {segment === 0
              ? 'Tryk på den røde knap for at optage din første stemme-note.'
              : 'Noter du gemmer, samles her.'}
          </PaperText>
        </View>
      ) : (
        groups.map((g) => (
          <View key={g.label}>
            <GroupLabel>{g.label}</GroupLabel>
            {g.items.map((note, i) => {
              const dur = durationLabel(note.durationSec);
              return (
                <View key={note.id}>
                  <Pressable
                    onLongPress={() => confirmDelete(note)}
                    accessibilityLabel={note.title ?? note.text.slice(0, 40)}
                    accessibilityHint="Hold nede for at slette"
                  >
                    <ListRow
                      leading={
                        note.source === 'voice' ? (
                          <WaveGlyph heights={barsFor(note.id)} color={papirColor.ink2} />
                        ) : (
                          <FileText size={18} color={papirColor.ink2} strokeWidth={1.7} />
                        )
                      }
                      title={note.title ?? note.text.slice(0, 48)}
                      subtitle={dur ? `${note.text.slice(0, 52)} · ${dur}` : note.text.slice(0, 60)}
                      trailing={trailingFor(note, now)}
                    />
                  </Pressable>
                  {i < g.items.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
                  ) : null}
                </View>
              );
            })}
          </View>
        ))
      )}
    </ScrollView>
  );
}
