// src/screens/OnboardingBackfillScreen.tsx
//
// Shown after MemoryConsentModal confirms, before the user lands on the
// Memory tab. Explains the backfill flow ("we'll read your recent
// emails and recurring meetings, store conclusions only"), lists which
// connected sources will be scanned, and offers Start / Skip.
//
// Visual style mirrors MicrosoftAdminConsentScreen (sage hero band,
// Playfair italic h1, Inter body, ink primary button) for consistency
// across onboarding flows. Wiring into App.tsx is Task 13.

import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { useConnections } from '../lib/hooks';
import { startBackfill } from '../lib/onboarding-backfill';
import { colors, fonts } from '../theme';

type Props = {
  onStart: () => void;
  onSkip: () => void;
  forceRerun?: boolean;
};

export function OnboardingBackfillScreen({ onStart, onSkip, forceRerun }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();
  const { data: connections } = useConnections();
  const [busy, setBusy] = useState(false);

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
  if (isConnected('google-calendar')) sources.push('Google Kalender');
  if (isConnected('outlook-calendar')) sources.push('Outlook Kalender');

  const noSources = sources.length === 0;

  const handleStart = async () => {
    setBusy(true);
    try {
      await startBackfill({ force: forceRerun });
      onStart();
    } catch {
      // The status screen handles failures; we just stop the spinner
      // and still advance — the user can retry from the Memory tab.
      onStart();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom + 32 }]}
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>LÆR DIG AT KENDE</Text>
          <Text style={styles.heroH1}>Lad Zolva lære dig at kende</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.body}>
            Vi læser hurtigt dine seneste emails og tilbagevendende møder for at finde ud af, hvem du arbejder med og hvad du arbejder med. Vi gemmer kun konklusionerne — ikke selve indholdet.
          </Text>
          <Text style={[styles.body, styles.bodySpaced]}>
            Du kan altid se og ændre, hvad Zolva har lært, i Hukommelse-fanen.
          </Text>

          <View style={styles.sourceList}>
            {noSources ? (
              <Text style={styles.sourceEmpty}>
                Ingen konti forbundet endnu — du kan altid lade Zolva lære dig at kende ved at chatte.
              </Text>
            ) : (
              sources.map((s) => (
                <View key={s} style={styles.sourceRow}>
                  <Text style={styles.sourceCheck}>✓</Text>
                  <Text style={styles.sourceLabel}>{s}</Text>
                </View>
              ))
            )}
          </View>

          <Pressable
            onPress={handleStart}
            disabled={busy || noSources}
            style={[
              styles.primaryBtn,
              (busy || noSources) && styles.primaryBtnDisabled,
            ]}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>
              {busy ? 'Starter…' : 'Start'}
            </Text>
          </Pressable>

          <Pressable
            onPress={onSkip}
            disabled={busy}
            style={styles.secondaryBtn}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryBtnText}>Spring over</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.paper },
  scroll: { flexGrow: 1, backgroundColor: colors.paper },
  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56,
    paddingBottom: 22,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 12,
    fontFamily: fonts.displayItalic,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -1,
    color: colors.ink,
  },
  section: { paddingHorizontal: 20, paddingTop: 24 },
  body: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.ink },
  bodySpaced: { marginTop: 12 },
  sourceList: {
    marginTop: 24,
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.mist,
    gap: 10,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sourceCheck: {
    fontFamily: fonts.uiSemi,
    fontSize: 14,
    color: colors.sageDeep,
    width: 16,
    textAlign: 'center',
  },
  sourceLabel: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.ink,
  },
  sourceEmpty: {
    fontFamily: fonts.ui,
    fontSize: 13,
    lineHeight: 19,
    color: colors.fg3,
  },
  primaryBtn: {
    marginTop: 24,
    backgroundColor: colors.ink,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 15,
    color: colors.paper,
  },
  secondaryBtn: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryBtnText: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.fg3,
  },
});
