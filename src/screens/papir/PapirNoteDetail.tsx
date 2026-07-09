// Detail view for a saved note/talenote. Recordings are transcript-only by
// design (the audio is discarded after transcription — see lib/types Note),
// so "open a recording" means reading the full transcript. Reached from
// Home's "Seneste optagelser" rows and the Historik lists.
import React from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { IconButton, PaperText, papirColor, papirSpace } from '../../design/papir';
import { useNotes } from '../../lib/hooks';
import { formatClock, formatToday } from '../../lib/date';
import { usePapirNav } from './nav';
import { PapirTag } from './PapirTag';
import { PushHeader } from './PushHeader';

function durationLabel(sec?: number): string {
  if (!sec || sec <= 0) return '';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function PapirNoteDetail({ id }: { id?: string }) {
  const nav = usePapirNav();
  const notes = useNotes();
  const note = notes.data.find((n) => n.id === id) ?? null;

  const confirmDelete = () => {
    if (!note) return;
    Alert.alert('Slet', `Slet "${note.title ?? note.text.slice(0, 40)}"?`, [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Slet',
        style: 'destructive',
        onPress: () => {
          notes.remove(note.id);
          nav.back();
        },
      },
    ]);
  };

  if (!note) {
    return (
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <PushHeader title="Optagelse" />
        <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Findes ikke længere
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>
            Denne optagelse er blevet slettet.
          </PaperText>
        </View>
      </View>
    );
  }

  const isVoice = note.source === 'voice';
  const d = formatToday(note.createdAt);
  const dur = durationLabel(note.durationSec);
  const meta = `${d.weekdayFull} ${d.day}. ${d.monthFull} · ${formatClock(note.createdAt)}${dur ? ` · ${dur}` : ''}`;

  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
      <PushHeader
        title={isVoice ? 'Talenote' : 'Note'}
        right={
          <IconButton accessibilityLabel="Slet" onPress={confirmDelete}>
            <Trash2 size={16} color={papirColor.ink2} strokeWidth={1.8} />
          </IconButton>
        }
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: papirSpace.screen, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <PapirTag label={isVoice ? 'Talenote' : 'Note'} kind={isVoice ? 'talenote' : 'note'} />
          <PaperText role="caption" color={papirColor.ink4} tabular>
            {meta}
          </PaperText>
        </View>
        {note.title ? (
          <PaperText role="titleSerif" style={{ fontSize: 24, marginTop: 16 }}>
            {note.title}
          </PaperText>
        ) : null}
        <PaperText role="body" color={papirColor.ink} style={{ marginTop: note.title ? 12 : 16, lineHeight: 26 }}>
          {note.text}
        </PaperText>
      </ScrollView>
    </View>
  );
}
