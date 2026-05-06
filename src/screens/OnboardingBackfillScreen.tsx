// src/screens/OnboardingBackfillScreen.tsx
//
// Shown after MemoryConsentModal confirms, before the user lands on the
// Memory tab. Explains the backfill flow ("we'll read your recent
// emails and recurring meetings, store conclusions only"), lists which
// connected sources will be scanned, and offers Start / Skip.
//
// Migrated to Glass & Air design system.

import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';
import { useAuth } from '../lib/auth';
import { useConnections, useIcloudConnected } from '../lib/hooks';
import { startBackfill } from '../lib/onboarding-backfill';

type Props = {
  onStart: () => void;
  onSkip: () => void;
  onConnectMore: () => void;
  forceRerun?: boolean;
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

  const { t, type, fonts, radius, spacing, surface } = useTheme();

  // Build the human-readable list of sources we'll scan. Only include
  // currently-connected providers — disconnected ones aren't relevant
  // to the user yet. Mirrors the IntegrationKey set the backfill
  // edge function actually consumes (mail + calendar; Drive isn't
  // backfilled).
  const sources: string[] = [];
  const isConnected = (id: string) =>
    connections.find((c) => c.id === id)?.status === 'connected';
  if (isConnected('gmail')) sources.push('Gmail');
  if (isConnected('outlook-mail')) sources.push('Outlook Mail');
  if (icloudConnected) sources.push('iCloud Mail');
  if (isConnected('google-calendar')) sources.push('Google Kalender');
  if (isConnected('outlook-calendar')) sources.push('Outlook Kalender');
  if (isConnected('google-drive')) sources.push('Google Drive');

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
      // the progress screen renders as muted+warning icons and the
      // review screen surfaces as a banner. No need to handle here.
    }
    onStart();
    setBusy(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <GlassHaloLayer />
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingBottom: chromeBottom + 32,
          paddingHorizontal: spacing.screenPad,
          paddingTop: spacing.statusBarFallback,
          gap: spacing.heroPad,
        }}
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
      >
        {/* Hero card — bone backdrop + Stone + display headline */}
        <GlassFrostedCard
          radius={radius.card}
          overlay={surface.bone}
          style={{
            paddingVertical: spacing.xl,
            paddingHorizontal: spacing.lg,
            alignItems: 'center',
            gap: spacing.md,
          }}
        >
          <Stone size={88} jumpOnTap={false} />
          <Text style={{ ...type.eyebrow, color: t.ink3, textAlign: 'center' }}>
            LÆR DIG AT KENDE
          </Text>
          <Text
            style={{
              ...type.displayL,
              color: t.ink,
              textAlign: 'center',
            }}
          >
            Lad Zolva lære{'\n'}dig at kende
          </Text>
        </GlassFrostedCard>

        {/* Body explainer card */}
        <GlassFrostedCard
          style={{ paddingVertical: spacing.cardPad, paddingHorizontal: spacing.cardPad, gap: spacing.md }}
        >
          <Text style={{ ...type.body, color: t.ink }}>
            Vi læser hurtigt dine seneste emails og tilbagevendende møder for at finde ud af, hvem du arbejder med og hvad du arbejder med. Vi gemmer kun konklusionerne — ikke selve indholdet.
          </Text>
          <Text style={{ ...type.body, color: t.ink }}>
            Du kan altid se og ændre, hvad Zolva har lært, i Hukommelse-fanen.
          </Text>
        </GlassFrostedCard>

        {/* Source list */}
        <GlassFrostedCard
          style={{ paddingVertical: spacing.cardPad, paddingHorizontal: spacing.cardPad, gap: spacing.sm }}
        >
          {noSources ? (
            <Text style={{ ...type.bodySm, color: t.ink3 }}>
              Ingen konti forbundet endnu — du kan altid lade Zolva lære dig at kende ved at chatte.
            </Text>
          ) : (
            sources.map((s, i) => (
              <View
                key={s}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingVertical: spacing.sm,
                  borderTopWidth: i > 0 ? 1 : 0,
                  borderTopColor: t.line,
                }}
              >
                <Text
                  style={{
                    fontFamily: fonts.uiBold,
                    fontSize: 14,
                    color: t.mem,
                    width: 16,
                    textAlign: 'center',
                  }}
                >
                  ✓
                </Text>
                <Text style={{ ...type.body, color: t.ink }}>{s}</Text>
              </View>
            ))
          )}
        </GlassFrostedCard>

        {/* CTAs */}
        <View style={{ gap: spacing.sm }}>
          {/* Primary — Start */}
          <Pressable
            onPress={handleStart}
            disabled={busy || noSources}
            accessibilityRole="button"
            style={({ pressed }) => ({
              backgroundColor: t.ink,
              paddingVertical: 14,
              borderRadius: radius.soft,
              alignItems: 'center',
              opacity: busy || noSources ? 0.4 : pressed ? 0.8 : 1,
            })}
          >
            <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: '#FFFFFF' }}>
              {busy ? 'Starter…' : 'Start'}
            </Text>
          </Pressable>

          {/* Secondary — Connect more */}
          <Pressable
            onPress={onConnectMore}
            disabled={busy}
            accessibilityRole="button"
          >
            <GlassFrostedCard
              style={{ paddingVertical: 12, alignItems: 'center' }}
            >
              <Text style={{ ...type.body, color: t.ink2, fontFamily: fonts.uiBold }}>
                Forbind flere konti først
              </Text>
            </GlassFrostedCard>
          </Pressable>

          <Text style={{ ...type.caption, color: t.ink3, textAlign: 'center' }}>
            Du kan altid scanne igen fra Hukommelse-fanen.
          </Text>

          {/* Tertiary — Skip */}
          <Pressable
            onPress={onSkip}
            disabled={busy}
            style={{ paddingVertical: 12, alignItems: 'center' }}
            accessibilityRole="button"
          >
            <Text style={{ ...type.body, color: t.ink3 }}>Spring over</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
