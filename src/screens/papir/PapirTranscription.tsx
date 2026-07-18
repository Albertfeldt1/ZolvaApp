import React, { useEffect, useRef, useState, type ComponentType } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Calendar, Clock, UserRound } from 'lucide-react-native';
import { deleteAsync } from 'expo-file-system/legacy';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useReminders, useNotes } from '../../lib/hooks';
import { runNetworkExtractor } from '../../lib/network-extractor';
import { runExtractor } from '../../lib/profile-extractor';
import {
  extractActions,
  transcribeAudio,
  TranscribeCancelled,
  TranscribeError,
  type ExtractedAction,
} from '../../lib/transcribe';
import {
  addVoiceEvent,
  addVoiceNetworkPerson,
  useVoiceActionCtx,
  VoiceEventConflictError,
  VoiceEventError,
  type CalendarProviderId,
} from '../../lib/voice-actions';
import { requestChatVoiceQuestion, usePapirNav } from './nav';
import { PapirLoader } from './PapirLoader';
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

/** "Slot taken" → let the user decide. Resolves true on "Opret alligevel". */
function confirmOverlap(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Tidspunktet er optaget',
      `${message}\n\nVil du oprette begivenheden alligevel?`,
      [
        { text: 'Annullér', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Opret alligevel', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

function ActionCard({ action, onAdd }: { action: ExtractedAction; onAdd: () => Promise<boolean> }) {
  const [state, setState] = useState<AddState>('idle');
  const Icon: IconCmp =
    action.kind === 'reminder' ? Clock : action.kind === 'network_person' ? UserRound : Calendar;
  const label =
    action.kind === 'reminder' ? 'Påmindelse' : action.kind === 'network_person' ? 'Netværk' : 'Begivenhed';
  // Netværkskort viser personen, de andre handlingens titel.
  const detail =
    action.kind === 'network_person'
      ? [action.name, action.company ?? action.howWeMet].filter(Boolean).join(' — ')
      : action.title;

  const run = async () => {
    if (state !== 'idle') return;
    setState('pending');
    try {
      // false = user cancelled (e.g. dismissed the provider picker) — back to
      // idle without an alert; cancelling is not an error (M2).
      const added = await onAdd();
      setState(added ? 'done' : 'idle');
    } catch (e) {
      setState('idle');
      const msg =
        e instanceof VoiceEventError || e instanceof Error ? e.message : 'Noget gik galt. Prøv igen.';
      Alert.alert(label, msg);
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
      {/* Approved-design category colors: reminders are red (spoken/urgent
          family), events green (agreement family), network slate (people/notes
          family) — same duos as the Home ribbon and Historik tags. */}
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: papirRadius.sm,
          backgroundColor:
            action.kind === 'reminder'
              ? papirColor.redSoft
              : action.kind === 'network_person'
                ? papirColor.slateSoft
                : papirColor.greenSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon
          size={17}
          color={
            action.kind === 'reminder'
              ? papirColor.red
              : action.kind === 'network_person'
                ? papirColor.slate
                : papirColor.green
          }
          strokeWidth={1.8}
        />
      </View>
      <View style={{ flex: 1 }}>
        <PaperText role="bodyStrong" style={{ fontSize: 14 }}>
          {label}
          {action.kind !== 'network_person' && action.time ? ` ${action.time}` : ''}
          {/* No resolvable time: say so BEFORE the tap — an event will refuse
              and a reminder lands without a due time (H11). */}
          {action.kind !== 'network_person' && !action.whenISO ? (
            <PaperText role="caption" color={papirColor.ink3}>
              {'  · uden tidspunkt'}
            </PaperText>
          ) : null}
        </PaperText>
        <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 2 }}>
          {detail}
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
  const nav = usePapirNav();

  // Send transskriptionen videre til chatten som et stemme-spørgsmål: chatten
  // sender den som en normal tur. Push før onDone, så chat-laget ligger klar
  // under overlayet når det lukker.
  // Optagelsen gemmes samtidig som talenote, så den også optræder under
  // historik/seneste optagelser — fejl her må ikke blokere spørgsmålet.
  const askZolva = (transcript: string, title?: string) => {
    notes
      .add(transcript, 'note', {
        ...(title ? { title } : {}),
        source: 'voice',
        ...(durationMillis ? { durationSec: Math.round(durationMillis / 1000) } : {}),
      })
      .catch((e) => {
        console.warn('[voice] save question note failed:', e instanceof Error ? e.message : String(e));
      });
    requestChatVoiceQuestion(transcript);
    nav.push('chat');
    onDone();
  };
  const askZolvaRef = useRef(askZolva);
  askZolvaRef.current = askZolva;

  useEffect(() => {
    let cancelled = false;
    // Kassér/back afmonterer skærmen → abort stopper den native upload, så
    // kvoten ikke forbrændes på en optagelse brugeren har smidt væk (M1).
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const transcript = await transcribeAudio(uri, abort.signal);
        // Whisper on silence returns empty/junk — don't offer to save a
        // meaningless "Tom optagelse" note (M14).
        if (!transcript.trim()) {
          if (!cancelled) setError('Optagelsen var tom. Prøv igen, og tal tæt på telefonen.');
          return;
        }
        const { title, actions, isQuestion } = await extractActions(transcript);
        if (cancelled) return;
        // Et rent spørgsmål ("hvad har jeg i morgen?") hører hjemme i chatten,
        // hvor Zolva faktisk kan svare — rut det direkte videre (askZolva
        // gemmer selv optagelsen som talenote). Blandede optagelser
        // (spørgsmål + handlinger) beholder handlingskortene; "Spørg
        // Zolva"-knappen dækker resten manuelt.
        if (isQuestion && actions.length === 0) {
          askZolvaRef.current(transcript, title);
          return;
        }
        // En begivenhed uden konkret tidspunkt ("senere", "en dag") kan
        // aldrig oprettes — addVoiceEvent afviser med "Tidspunktet er for
        // upræcist…", så Tilføj-knappen ville altid fejle. Konvertér til en
        // påmindelse i stedet: de er lovlige uden tidspunkt ("minder dig
        // løbende") og bevarer handlingen frem for at gemme den væk.
        const usableActions = actions.map((a): ExtractedAction =>
          a.kind === 'event' && !a.whenISO
            ? { kind: 'reminder', title: a.title, ...(a.time ? { time: a.time } : {}) }
            : a,
        );
        setData({ title, transcript, actions: usableActions });
      } catch (e) {
        if (e instanceof TranscribeCancelled) return; // brugerens eget valg — ingen fejl
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
      abort.abort();
    };
  }, [uri, attempt]);

  // The recorder's temp file is only needed while this screen can still
  // retry. Audio is not kept (transcript-only by design) — clean up on exit.
  useEffect(() => {
    return () => {
      deleteAsync(uri, { idempotent: true }).catch(() => {});
    };
  }, [uri]);

  // Resolves null when the user dismisses the sheet — cancel, not error (M2).
  const pickProvider = (): Promise<CalendarProviderId | null> => {
    if (calendarProviders.length === 1) return Promise.resolve(calendarProviders[0]);
    return new Promise((resolve) => {
      setPickFor({
        action: { kind: 'event', title: '' },
        resolve: (p) => {
          setPickFor(null);
          resolve(p);
        },
        reject: () => {
          setPickFor(null);
          resolve(null);
        },
      });
    });
  };

  /** Returns true when added, false when the user cancelled. */
  const addAction = async (action: ExtractedAction): Promise<boolean> => {
    if (action.kind === 'network_person') {
      await addVoiceNetworkPerson(ctx.userId, action);
      return true;
    }
    if (action.kind === 'reminder') {
      const due = action.whenISO ? new Date(action.whenISO) : undefined;
      await reminders.add(action.title, due && !Number.isNaN(due.getTime()) ? due : undefined);
      return true;
    }
    if (calendarProviders.length === 0) {
      throw new VoiceEventError('Ingen kalender forbundet. Forbind en kalender i Indstillinger.');
    }
    const provider = await pickProvider();
    if (!provider) return false;
    try {
      await addVoiceEvent(ctx, provider, action);
    } catch (e) {
      // Slot taken → ask instead of failing; declining is a cancel, not an
      // error. On confirm, retry the exact same event past the conflict check.
      if (!(e instanceof VoiceEventConflictError)) throw e;
      const overlap = await confirmOverlap(e.message);
      if (!overlap) return false;
      await addVoiceEvent(ctx, provider, action, { forceOverlap: true });
    }
    return true;
  };

  const saveNote = async () => {
    if (!data || saving) return;
    setSaving(true);
    try {
      const saved = await notes.add(data.transcript, 'note', {
        title: data.title,
        source: 'voice',
        ...(durationMillis ? { durationSec: Math.round(durationMillis / 1000) } : {}),
      });
      // Gemte talenoter mines i baggrunden - personer til Netværk og fakta
      // til Husk. Kun her: et voice-SPØRGSMÅL (askZolva) bliver en chat-tur
      // og dækkes af chat-hooket, så det ville dobbelt-ekstrahere.
      if (ctx.userId) {
        runNetworkExtractor({
          trigger: 'voice_note',
          userId: ctx.userId,
          text: data.transcript,
          // Note-id'et med: addInteraction dedupliker på (person, sourceRef),
          // så et fast 'voice-note' gav max ÉN talenote-linje i Historik
          // pr. person nogensinde.
          source: `voice-note:${saved.id}`,
        });
        runExtractor({
          trigger: 'voice_note',
          userId: ctx.userId,
          text: data.transcript,
          source: 'voice-note',
        });
      }
      onDone();
    } catch (e) {
      setSaving(false);
      // The store's errors are internal English strings — translate the one
      // real user-cause (signed out) and keep the rest generic (M3).
      const raw = e instanceof Error ? e.message : '';
      const msg = raw.includes('No active user')
        ? 'Du skal være logget ind for at gemme noter.'
        : 'Noten kunne ikke gemmes. Prøv igen.';
      Alert.alert('Gem note', msg);
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
            {/* The waveform loader is at its most literal here: the app is
                actively listening back through the take. */}
            <PapirLoader size={28} />
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
                    Zolva fandt {data.actions.length} {data.actions.length === 1 ? 'handling' : 'handlinger'}
                  </PaperText>
                </View>
                {data.actions.map((a, i) => (
                  <ActionCard
                    key={`${a.kind}-${a.kind === 'network_person' ? a.name : a.title}-${i}`}
                    action={a}
                    onAdd={() => addAction(a)}
                  />
                ))}
              </View>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: papirSpace.screen, paddingTop: 28 }}>
              <Button label="Kassér" variant="ghost" style={{ paddingHorizontal: 24 }} onPress={onDone} disabled={saving} />
              <Button label={saving ? 'Gemmer…' : 'Gem note'} variant="primary" style={{ flex: 1 }} onPress={saveNote} disabled={saving} />
            </View>
            {/* Fallback når klassifikationen tager fejl: enhver optagelse kan
                sendes til chatten og få et svar. */}
            <View style={{ paddingHorizontal: papirSpace.screen, paddingTop: 12 }}>
              <Button
                label="Spørg Zolva om det her"
                variant="ghost"
                onPress={() => askZolva(data.transcript, data.title)}
                disabled={saving}
              />
            </View>
          </>
        ) : null}
      </ScrollView>

      {/* Calendar provider picker (only when >1 calendar is connected) */}
      {pickFor ? (
        <View style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end' }]}>
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(27,26,23,0.35)' }]}
            onPress={() => pickFor.reject(new Error('cancelled'))}
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
