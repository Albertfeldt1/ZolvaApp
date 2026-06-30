import React, { useEffect, useState, type ComponentType } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { Calendar, Clock } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { extractActions, transcribeAudio, type ExtractedAction } from '../../lib/transcribe';
import { PushHeader } from './PushHeader';

type Props = {
  /** Local audio URI to transcribe. Omit for the demo/mock preview. */
  uri?: string | null;
  onDone?: () => void;
};

type Loaded = { title: string; transcript: string; actions: ExtractedAction[] };

const DEMO: Loaded = {
  title: 'Aflevering til Ole',
  transcript:
    'Husk lige at ringe til Ole inden frokost om afleveringen. Jeg skal aflevere de to dyr klokken 13.55, og jeg vil gerne mindes om det en halv time før.',
  actions: [
    { kind: 'reminder', title: 'Ring til Ole inden frokost', time: '13.25' },
    { kind: 'event', title: 'Aflever 2 dyr til Ole', time: '13.55' },
  ],
};

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

export function PapirTranscription({ uri, onDone }: Props) {
  const [loading, setLoading] = useState(!!uri);
  const [data, setData] = useState<Loaded>(DEMO);

  useEffect(() => {
    if (!uri) return; // demo mode — show mock immediately
    let cancelled = false;
    (async () => {
      try {
        const transcript = await transcribeAudio(uri);
        const { title, actions } = await extractActions(transcript);
        if (!cancelled) setData({ title, transcript, actions });
      } catch {
        // Not logged in / backend not deployed yet → fall back to demo so the
        // flow stays demonstrable in preview.
        if (!cancelled) setData(DEMO);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uri]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Ny optagelse" />

      {loading ? (
        <View style={{ alignItems: 'center', paddingTop: 80, gap: 14 }}>
          <ActivityIndicator color={papirColor.red} />
          <PaperText role="body" color={papirColor.ink2}>
            Skriver din optagelse ned…
          </PaperText>
        </View>
      ) : (
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
                <ActionCard key={i} action={a} />
              ))}
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: papirSpace.screen, paddingTop: 28 }}>
            <Button label="Kassér" variant="ghost" style={{ paddingHorizontal: 24 }} onPress={onDone} />
            <Button label="Gem note" variant="primary" style={{ flex: 1 }} onPress={onDone} />
          </View>
        </>
      )}
    </ScrollView>
  );
}
