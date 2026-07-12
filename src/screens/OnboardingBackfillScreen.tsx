// src/screens/OnboardingBackfillScreen.tsx
//
// Shown after MemoryConsentModal confirms, before the user lands on the
// Memory tab. Explains the backfill flow ("we'll read your recent
// emails and recurring meetings, store conclusions only"), lists which
// connected sources will be scanned, and offers Start / Skip.
//
// Papir-redesign — "Titelbladet, side to": samme rolige dokument-sprog som
// login. Brand-bølgen ånder øverst, Fraunces bærer overskriften, kilderne
// står som stille rækker på ét hvidt ark, og privatlivsløftet er en del af
// fortællingen — ikke det med småt.

import { useState } from 'react';
import { Image, ImageSourcePropType, ScrollView, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import { useChromeInsets } from '../components/PhoneChrome';
import {
  BreathingWave,
  PaperText,
  papirColor,
  papirRadius,
  papirShadow,
  papirSpace,
} from '../design/papir';
import { ScaleButton } from '../design/motion';
import { useAuth } from '../lib/auth';
import { useConnections, useIcloudConnected } from '../lib/hooks';
import { startBackfill } from '../lib/onboarding-backfill';

type Props = {
  onStart: () => void;
  onSkip: () => void;
  onConnectMore: () => void;
  forceRerun?: boolean;
};

type SourceRow = { label: string; detail: string; logo: ImageSourcePropType };

const SOURCE_META: Record<string, Omit<SourceRow, 'label'> & { label: string }> = {
  gmail: {
    label: 'Gmail',
    detail: 'Seneste mails og hvem du skriver med',
    logo: require('../../assets/logos/gmail.png'),
  },
  'outlook-mail': {
    label: 'Outlook Mail',
    detail: 'Seneste mails og hvem du skriver med',
    logo: require('../../assets/logos/outlook-mail.png'),
  },
  icloud: {
    label: 'iCloud Mail',
    detail: 'Seneste mails og hvem du skriver med',
    logo: require('../../assets/logos/icloud.png'),
  },
  'google-calendar': {
    label: 'Google Kalender',
    detail: 'Tilbagevendende møder og din rytme',
    logo: require('../../assets/logos/google-calendar.png'),
  },
  'outlook-calendar': {
    label: 'Outlook Kalender',
    detail: 'Tilbagevendende møder og din rytme',
    logo: require('../../assets/logos/outlook-calendar.png'),
  },
  'google-drive': {
    label: 'Google Drive',
    detail: 'Dokumenter du arbejder i',
    logo: require('../../assets/logos/google-drive.png'),
  },
  onedrive: {
    label: 'OneDrive',
    detail: 'Dokumenter du arbejder i',
    logo: require('../../assets/logos/onedrive.png'),
  },
};

export function OnboardingBackfillScreen({ onStart, onSkip, onConnectMore, forceRerun }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();
  const { data: connections } = useConnections();
  const { user } = useAuth();
  // useConnections only knows about Google + Microsoft; iCloud lives in
  // SecureStore and needs its own gate. Without this the Start button
  // disables itself for iCloud-only accounts and the user dead-ends here.
  const icloudConnected = useIcloudConnected(user?.id ?? '');
  const [busy, setBusy] = useState(false);

  // Build the human-readable list of sources we'll scan. Only include
  // currently-connected providers - disconnected ones aren't relevant
  // to the user yet. Mirrors the IntegrationKey set the backfill
  // edge function actually consumes (mail + calendar; Drive isn't
  // backfilled).
  const isConnected = (id: string) =>
    connections.find((c) => c.id === id)?.status === 'connected';
  const sourceIds = [
    'gmail',
    'outlook-mail',
    'icloud',
    'google-calendar',
    'outlook-calendar',
    'google-drive',
    'onedrive',
  ].filter((id) => (id === 'icloud' ? icloudConnected : isConnected(id)));
  const sources = sourceIds.map((id) => SOURCE_META[id]);

  const noSources = sources.length === 0;

  const handleStart = async () => {
    if (busy) return;
    setBusy(true);
    // Await the start call itself so the progress screen's first poll
    // doesn't see stale jobs from a previous run. The HTTP call returns
    // after rows are cleared/inserted (sub-second); the workers run
    // async after that and the progress screen polls for their state.
    // Without awaiting, force:true reruns hit a race where the first
    // poll returns the previous run's done jobs and the screen
    // erroneously declares completion before the new run starts.
    try {
      await startBackfill({ force: forceRerun });
    } catch {
      // Failures show up as 'failed' jobs in the polling stream, which
      // the progress screen renders as muted lines and the review screen
      // surfaces as a banner. No need to handle here.
    }
    onStart();
    setBusy(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingBottom: chromeBottom + papirSpace.xl,
          paddingHorizontal: papirSpace.screen,
          paddingTop: 76,
        }}
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
      >
        {/* Titelbladet: bølge, eyebrow, Fraunces-overskrift, serif-løfte. */}
        <View style={{ gap: papirSpace.lg }}>
          <Animated.View entering={FadeIn.duration(700)}>
            <BreathingWave scale={0.8} />
          </Animated.View>
          <Animated.View
            entering={FadeInDown.delay(100).duration(560).easing(Easing.out(Easing.quad))}
            style={{ gap: papirSpace.md }}
          >
            <PaperText role="eyebrow" color={papirColor.ink3}>
              Lær mig at kende
            </PaperText>
            <PaperText role="displayM" accessibilityRole="header">
              Må jeg læse med et øjeblik?
            </PaperText>
          </Animated.View>
          <Animated.View entering={FadeInDown.delay(220).duration(560).easing(Easing.out(Easing.quad))}>
            <PaperText role="bodySerif" color={papirColor.ink2}>
              Jeg kigger dine seneste mails og faste møder igennem for at forstå, hvem du
              arbejder med — og hvad der fylder. Jeg gemmer kun konklusionerne, aldrig
              selve indholdet.
            </PaperText>
          </Animated.View>
        </View>

        {/* Arket: kilderne der læses. */}
        <Animated.View
          entering={FadeInUp.delay(320).duration(600).easing(Easing.out(Easing.cubic))}
          style={{
            backgroundColor: papirColor.card,
            borderRadius: papirRadius.card,
            paddingVertical: papirSpace.sm,
            paddingHorizontal: papirSpace.lg,
            marginTop: papirSpace.xxl,
            ...papirShadow.base,
          }}
        >
          {noSources ? (
            <PaperText role="body" color={papirColor.ink3} style={{ paddingVertical: papirSpace.md }}>
              Ingen konti forbundet endnu — du kan altid lade mig lære dig at kende
              gennem chatten.
            </PaperText>
          ) : (
            sources.map((s, i) => (
              <Animated.View
                key={s.label}
                entering={FadeInDown.delay(420 + i * 70).duration(440).easing(Easing.out(Easing.quad))}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: papirSpace.md,
                  paddingVertical: papirSpace.md,
                  borderTopWidth: i > 0 ? 1 : 0,
                  borderTopColor: papirColor.lineSoft,
                }}
              >
                <View
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: papirRadius.sm,
                    backgroundColor: papirColor.paper2,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Image source={s.logo} style={{ width: 20, height: 20 }} resizeMode="contain" />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <PaperText role="bodyStrong">{s.label}</PaperText>
                  <PaperText role="caption" color={papirColor.ink3}>
                    {s.detail}
                  </PaperText>
                </View>
              </Animated.View>
            ))
          )}
        </Animated.View>

        <View style={{ flex: 1 }} />

        {/* Handlinger. */}
        <Animated.View
          entering={FadeInUp.delay(480).duration(560).easing(Easing.out(Easing.cubic))}
          style={{ gap: papirSpace.md, marginTop: papirSpace.xxl }}
        >
          <ScaleButton
            scaleTo={0.97}
            haptic="light"
            onPress={handleStart}
            disabled={busy || noSources}
            accessibilityRole="button"
            accessibilityLabel="Begynd"
            accessibilityState={{ disabled: busy || noSources, busy }}
            style={{
              height: 56,
              borderRadius: papirRadius.lg,
              backgroundColor: papirColor.ink,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: busy || noSources ? 0.45 : 1,
            }}
          >
            <PaperText role="button" color={papirColor.onInk}>
              {busy ? 'Begynder…' : 'Begynd'}
            </PaperText>
          </ScaleButton>

          <ScaleButton
            scaleTo={0.97}
            haptic="light"
            onPress={onConnectMore}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Forbind flere konti først"
            style={{
              height: 56,
              borderRadius: papirRadius.lg,
              backgroundColor: papirColor.card,
              borderWidth: 1,
              borderColor: papirColor.line,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PaperText role="button">Forbind flere konti først</PaperText>
          </ScaleButton>

          <ScaleButton
            scaleTo={0.98}
            haptic="none"
            onPress={onSkip}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Spring over"
            style={{ paddingVertical: papirSpace.md, alignItems: 'center' }}
          >
            <PaperText role="small" color={papirColor.ink3}>
              Spring over
            </PaperText>
          </ScaleButton>

          <PaperText
            role="caption"
            color={papirColor.ink3}
            style={{ textAlign: 'center' }}
          >
            Du kan altid se, rette og scanne igen under Hukommelse.
          </PaperText>
        </Animated.View>
      </ScrollView>
    </View>
  );
}
