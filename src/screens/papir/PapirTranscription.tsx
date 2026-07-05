import React, { useEffect, useState, type ComponentType } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Calendar, Clock } from 'lucide-react-native';
import { deleteAsync } from 'expo-file-system/legacy';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useReminders, useNotes } from '../../lib/hooks';
import { extractActions, transcribeAudio, TranscribeError, type ExtractedAction } from '../../lib/transcribe';
import {
  addVoiceEvent,
  useVoiceActionCtx,
  VoiceEventError,
  type CalendarProviderId,
} from '../../lib/voice-actions';
import { PushHeader } from './PushHeader';

type Props = {
  /** Local audio URI to transcribe. */
  uri: string;
  /** Recording length in ms (threaded from PapirRecord). */
  durationMillis?: number;
  onDone: () => void;
};

type Loaded = { title: string; transcript: string; actions: ExtractedAction[] };

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const PROVIDER_LABELS: Record<CalendarProviderId, string> = {
  google: 'Google Kalender',
  microsoft: 'Outlook Kalender',
  icloud: 'iCloud Kalender',
};

type AddState = 'idle' | 'pending' | 'done';

function ActionCard({ action, onAdd }: { action: ExtractedAction; onAdd: () => Promise<void> }) {
  const [state, setState] = useState<AddState>('idle');
  const Icon: IconCmp = action.kind === 'reminder' ? Clock : Calendar;
  const label = action.kind === 'reminder' ? 'Påmindelse' : 'Begivenhed';

  const run = async () => {
    if (state !== 'idle') return;
    setState('pending');
    try {
      await onAdd();
      setState('done');
    } catch (e) {
      setState('idle');
      const msg =
        e instanceof VoiceEventError || e instanceof Error ? e.message : 'Noget gik galt. Prøv igen.';
      Alert.alert(action.kind === 'reminder' ? 'Påmindelse' : 'Begivenhed', msg);
    }
  };

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
        onPress={run}
        disabled={state !== 'idle'}
        style={{
          backgroundColor: state === 'done' ? papirColor.green : papirColor.ink,
          paddingVertical: 8,
          paddingHorizontal: 15,
          borderRadius: papirRadius.pill,
          minWidth: 74,
          alignItems: 'center',
        }}
      >
        {state === 'pending' ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <PaperText role="small" color="#FFFFFF">
            {state === 'done' ? 'Tilføjet ✓' : 'Tilføj'}
          </PaperText>
        )}
      </ScaleButton>
    </View>
  );
}

export function PapirTranscription({ uri, durationMillis, onDone }: Props) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  // Event actions with >1 connected calendar → user picks a provider first.
  const [pickFor, setPickFor] = useState<{
    action: Extract<ExtractedAction, { kind: 'event' }>;
    resolve: (p: CalendarProviderId) => void;
    reject: (e: Error) => void;
  } | null>(null);

  const reminders = useReminders();
  const notes = useNotes();
  const { ctx, calendarProviders } = useVoiceActionCtx();

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

  const pickProvider = (): Promise<CalendarProviderId> => {
    if (calendarProviders.length === 1) return Promise.resolve(calendarProviders[0]);
    return new Promise((resolve, reject) => {
      // Sheet below resolves/rejects; storing the action only for display.
      setPickFor({
        action: { kind: 'event', title: '' },
        resolve: (p) => {
          setPickFor(null);
          resolve(p);
        },
        reject: (e) => {
          setPickFor(null);
          reject(e);
        },
      });
    });
  };

  const addAction = async (action: ExtractedAction): Promise<void> => {
    if (action.kind === 'reminder') {
      const due = action.whenISO ? new Date(action.whenISO) : undefined;
      await reminders.add(action.title, due && !Number.isNaN(due.getTime()) ? due : undefined);
      return;
    }
    if (calendarProviders.length === 0) {
      throw new VoiceEventError('Ingen kalender forbundet. Forbind en kalender i Indstillinger.');
    }
    const provider = await pickProvider();
    await addVoiceEvent(ctx, provider, action);
  };

  const saveNote = async () => {
    if (!data || saving) return;
    setSaving(true);
    try {
      await notes.add(data.transcript, 'note', {
        title: data.title,
        source: 'voice',
        ...(durationMillis ? { durationSec: Math.round(durationMillis / 1000) } : {}),
      });
      onDone();
    } catch (e) {
      setSaving(false);
      Alert.alert('Gem note', e instanceof Error ? e.message : 'Noten kunne ikke gemmes. Prøv igen.');
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
      <ScrollView
        style={{ flex: 1 }}
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
                  <ActionCard key={`${a.kind}-${a.title}-${i}`} action={a} onAdd={() => addAction(a)} />
                ))}
              </View>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: papirSpace.screen, paddingTop: 28 }}>
              <Button label="Kassér" variant="ghost" style={{ paddingHorizontal: 24 }} onPress={onDone} disabled={saving} />
              <Button label={saving ? 'Gemmer…' : 'Gem note'} variant="primary" style={{ flex: 1 }} onPress={saveNote} disabled={saving} />
            </View>
          </>
        ) : null}
      </ScrollView>

      {/* Calendar provider picker (only when >1 calendar is connected) */}
      {pickFor ? (
        <View style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end' }]}>
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(27,26,23,0.35)' }]}
            onPress={() => pickFor.reject(new VoiceEventError('Annulleret.'))}
            accessibilityLabel="Luk kalendervalg"
          />
          <View
            style={{
              backgroundColor: papirColor.card,
              borderTopLeftRadius: papirRadius.card,
              borderTopRightRadius: papirRadius.card,
              paddingHorizontal: papirSpace.screen,
              paddingTop: 22,
              paddingBottom: 40,
              gap: 10,
            }}
          >
            <PaperText role="bodyStrong" style={{ marginBottom: 6 }}>
              Hvilken kalender?
            </PaperText>
            {calendarProviders.map((p) => (
              <Button key={p} label={PROVIDER_LABELS[p]} variant="ghost" onPress={() => pickFor.resolve(p)} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
