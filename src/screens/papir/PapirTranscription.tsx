import React, { useEffect, useState, type ComponentType } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { Calendar, Clock } from 'lucide-react-native';
import { deleteAsync } from 'expo-file-system/legacy';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { extractActions, transcribeAudio, TranscribeError, type ExtractedAction } from '../../lib/transcribe';
import { PushHeader } from './PushHeader';

type Props = {
  /** Local audio URI to transcribe. */
  uri: string;
  /** Recording length in ms (threaded from PapirRecord; persisted in M1). */
  durationMillis?: number;
  onDone: () => void;
};

type Loaded = { title: string; transcript: string; actions: ExtractedAction[] };

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

function ActionCard({ action }: { action: ExtractedAction }) {
  const [added, setAdded] = useState(false);
  const Icon: IconCmp = action.kind === 'reminder' ? Clock : Calendar;
  const label = action.kind === 'reminder' ? 'Påmindelse' : 'Begivenhed';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: papirColor.card,
        borderWidth: 1,
        borderColor: papirColor.line,
        borderRadius: papirRadius.md,
        padding: 12,
        marginTop: 12,
      }}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: papirRadius.sm,
          backgroundColor: papirColor.redSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon size={17} color={papirColor.red} strokeWidth={1.8} />
      </View>
      <View style={{ flex: 1 }}>
        <PaperText role="bodyStrong" style={{ fontSize: 14 }}>
          {label}
          {action.time ? ` ${action.time}` : ''}
        </PaperText>
        <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 2 }}>
          {action.title}
        </PaperText>
      </View>
      <ScaleButton
        scaleTo={0.92}
        haptic="light"
        onPress={() => setAdded(true)}
        disabled={added}
        style={{
          backgroundColor: added ? papirColor.green : papirColor.ink,
          paddingVertical: 8,
          paddingHorizontal: 15,
          borderRadius: papirRadius.pill,
        }}
      >
        <PaperText role="small" color="#FFFFFF">
          {added ? 'Tilføjet ✓' : 'Tilføj'}
        </PaperText>
      </ScaleButton>
    </View>
  );
}

export function PapirTranscription({ uri, durationMillis, onDone }: Props) {
  void durationMillis; // persisted with the note in M1
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const transcript = await transcribeAudio(uri);
        const { title, actions } = await extractActions(transcript);
        if (!cancelled) setData({ title, transcript, actions });
      } catch (e) {
        // Show the real failure — never invent content the user didn't record.
        const msg =
          e instanceof TranscribeError ? e.message : 'Transskriberingen fejlede. Prøv igen.';
        console.warn('[voice] transcription failed:', e instanceof Error ? e.message : String(e));
        if (!cancelled) setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uri, attempt]);

  // The recorder's temp file is only needed while this screen can still
  // retry. Audio is not kept (transcript-only by design) — clean up on exit.
  useEffect(() => {
    return () => {
      deleteAsync(uri, { idempotent: true }).catch(() => {});
    };
  }, [uri]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Ny optagelse" onBack={onDone} />

      {loading ? (
        <View style={{ alignItems: 'center', paddingTop: 80, gap: 14 }}>
          <ActivityIndicator color={papirColor.red} />
          <PaperText role="body" color={papirColor.ink2}>
            Skriver din optagelse ned…
          </PaperText>
        </View>
      ) : error ? (
        <View style={{ alignItems: 'center', paddingTop: 80, gap: 18, paddingHorizontal: papirSpace.screen }}>
          <PaperText role="body" color={papirColor.ink2} style={{ textAlign: 'center' }}>
            {error}
          </PaperText>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <Button label="Kassér" variant="ghost" style={{ paddingHorizontal: 24 }} onPress={onDone} />
            <Button label="Prøv igen" variant="primary" style={{ paddingHorizontal: 24 }} onPress={() => setAttempt((a) => a + 1)} />
          </View>
        </View>
      ) : data ? (
        <>
          <View style={{ paddingHorizontal: papirSpace.screen }}>
            <PaperText role="caption" color={papirColor.ink3} tabular>
              I dag · stemme-note
            </PaperText>
            <PaperText role="displayS" style={{ marginTop: 10 }}>
              {data.title}
            </PaperText>
            <PaperText role="bodySerif" style={{ marginTop: 18 }}>
              {data.transcript}
            </PaperText>
          </View>

          {data.actions.length > 0 ? (
            <View
              style={{
                marginHorizontal: papirSpace.screen,
                marginTop: 26,
                padding: 18,
                borderRadius: papirRadius.xxl,
                backgroundColor: papirColor.paper2,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: papirColor.red }} />
                <PaperText role="bodyStrong" style={{ fontSize: 13 }}>
                  Zolva fandt {data.actions.length} {data.actions.length === 1 ? 'ting' : 'ting'}
                </PaperText>
              </View>
              {data.actions.map((a, i) => (
                <ActionCard key={`${a.kind}-${a.title}-${i}`} action={a} />
              ))}
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: papirSpace.screen, paddingTop: 28 }}>
            <Button label="Kassér" variant="ghost" style={{ paddingHorizontal: 24 }} onPress={onDone} />
            <Button label="Gem note" variant="primary" style={{ flex: 1 }} onPress={onDone} />
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}
