import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { CheckCircle2, FileText, Search } from 'lucide-react-native';
import { Chip, ListRow, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useNotes, useReminders } from '../../lib/hooks';
import type { Note, Reminder } from '../../lib/types';
import { usePapirNav } from './nav';
import { PushHeader } from './PushHeader';
import { barsFor, WaveGlyph } from './WaveGlyph';

const FILTERS = ['Alt', 'Optagelser', 'Noter', 'Opgaver'] as const;

type Hit =
  | { kind: 'voice' | 'note'; note: Note }
  | { kind: 'task'; reminder: Reminder };

const WEEKDAYS_SHORT = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];

function trailingFor(d: Date, now: Date): string {
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (daysAgo >= 0 && daysAgo < 7) return WEEKDAYS_SHORT[d.getDay()];
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function PapirSearch() {
  const nav = usePapirNav();
  const [filter, setFilter] = useState(0);
  const [query, setQuery] = useState('');
  const notes = useNotes();
  const reminders = useReminders();
  const now = new Date();

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const f = FILTERS[filter];
    const out: Hit[] = [];
    if (f === 'Alt' || f === 'Optagelser' || f === 'Noter') {
      notes.data
        .filter((n) => {
          const isVoice = n.source === 'voice';
          if (f === 'Optagelser' && !isVoice) return false;
          if (f === 'Noter' && isVoice) return false;
          return (n.title ?? '').toLowerCase().includes(q) || n.text.toLowerCase().includes(q);
        })
        .forEach((n) => out.push({ kind: n.source === 'voice' ? 'voice' : 'note', note: n }));
    }
    if (f === 'Alt' || f === 'Opgaver') {
      reminders.data
        .filter((r) => r.text.toLowerCase().includes(q))
        .forEach((r) => out.push({ kind: 'task', reminder: r }));
    }
    // Newest first across kinds.
    return out.sort((a, b) => {
      const da = a.kind === 'task' ? a.reminder.createdAt : a.note.createdAt;
      const db = b.kind === 'task' ? b.reminder.createdAt : b.note.createdAt;
      return db.getTime() - da.getTime();
    });
  }, [query, filter, notes.data, reminders.data]);

  const openHit = (h: Hit) => {
    // Results live in Historik (notes/recordings) or Plan (tasks).
    nav.setTab(h.kind === 'task' ? 'plan' : 'history');
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <PushHeader title="Søg" />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          marginHorizontal: papirSpace.screen,
          paddingVertical: 4,
          paddingHorizontal: 16,
          borderWidth: 1,
          borderColor: papirColor.line,
          borderRadius: papirRadius.lg,
          backgroundColor: papirColor.card,
        }}
      >
        <Search size={19} color={papirColor.ink3} strokeWidth={1.8} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Søg i noter og opgaver"
          placeholderTextColor={papirColor.ink4}
          autoFocus
          style={{ flex: 1, fontSize: 15, color: papirColor.ink, paddingVertical: 12 }}
          accessibilityLabel="Søgefelt"
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: papirSpace.screen, paddingTop: 18 }}
      >
        {FILTERS.map((f, i) => (
          <Chip key={f} label={f} active={i === filter} onPress={() => setFilter(i)} />
        ))}
      </ScrollView>

      {query.trim() === '' ? (
        <PaperText role="body" color={papirColor.ink3} style={{ paddingHorizontal: papirSpace.screen, paddingTop: 40, textAlign: 'center' }}>
          Søg på tværs af dine optagelser, noter og opgaver.
        </PaperText>
      ) : (
        <>
          <PaperText
            role="eyebrow"
            color={papirColor.ink3}
            style={{ paddingHorizontal: papirSpace.screen, paddingTop: 22, paddingBottom: 8 }}
          >
            {hits.length} {hits.length === 1 ? 'resultat' : 'resultater'}
          </PaperText>
          {hits.map((h, i) => {
            const key = h.kind === 'task' ? `t-${h.reminder.id}` : `n-${h.note.id}`;
            return (
              <View key={key}>
                <Pressable onPress={() => openHit(h)} accessibilityRole="button">
                  {h.kind === 'task' ? (
                    <ListRow
                      leading={<CheckCircle2 size={18} color={papirColor.ink2} strokeWidth={1.7} />}
                      title={h.reminder.text}
                      subtitle={h.reminder.status === 'done' ? 'Klaret' : 'Opgave'}
                      trailing={trailingFor(h.reminder.dueAt ?? h.reminder.createdAt, now)}
                    />
                  ) : (
                    <ListRow
                      leading={
                        h.kind === 'voice' ? (
                          <WaveGlyph heights={barsFor(h.note.id)} color={papirColor.ink2} />
                        ) : (
                          <FileText size={18} color={papirColor.ink2} strokeWidth={1.7} />
                        )
                      }
                      title={h.note.title ?? h.note.text.slice(0, 48)}
                      subtitle={h.note.text.slice(0, 60)}
                      trailing={trailingFor(h.note.createdAt, now)}
                    />
                  )}
                </Pressable>
                {i < hits.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
                ) : null}
              </View>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}
