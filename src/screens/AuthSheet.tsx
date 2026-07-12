// Logged-out sign-in experience — "Titelbladet".
//
// Designet som den første side i et smukt sat dokument frem for en skærm med
// tre knapper: en levende, åndende brand-bølge i terracotta, en tidsafhængig
// serif-hilsen, tre stille linjer om hvad Zolva gør — og ét hvidt "ark" der
// bærer selve login-handlingerne. Alt motion kører som transform/opacity på
// UI-tråden (Reanimated), så koreografien holder 60 fps.
//
// Rendered by App.tsx and PapirRoot as an Animated.View overlay (NOT a native
// Modal — see the iOS modal-stacking lesson). Offers the three real account
// providers; iCloud mail is connected later, inside onboarding. Fixed top/
// bottom paddings instead of safe-area insets: the classic App.tsx mount has
// no SafeAreaProvider, and useSafeAreaInsets would throw there.
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import Svg, { Path, Rect } from 'react-native-svg';
import { CalendarDays, Mail, Mic } from 'lucide-react-native';
import { useAuth } from '../lib/auth';
import { greeting } from '../lib/date';
import {
  BreathingWave,
  PaperText,
  papirColor,
  papirDuration,
  papirFont,
  papirRadius,
  papirShadow,
  papirSpace,
} from '../design/papir';
import { ScaleButton } from '../design/motion';

interface Props {
  /** Called after a successful sign-in or when the user dismisses the sheet. */
  onClose: () => void;
}

type ProviderId = 'apple' | 'google' | 'microsoft';

// ─── Udbyder-ikoner ──────────────────────────────────────────────────────────
// Officielle mærker som kompakte inline-SVG'er. Apple følger knappens
// tekstfarve; Google og Microsoft beholder deres brandfarver på lyse knapper.

function AppleMark({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        fill={color}
        d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"
      />
    </Svg>
  );
}

function GoogleMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <Path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <Path
        fill="#FBBC05"
        d="M5.27 14.29c-.24-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
      />
      <Path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </Svg>
  );
}

function MicrosoftMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Rect x={1} y={1} width={10.5} height={10.5} fill="#F25022" />
      <Rect x={12.5} y={1} width={10.5} height={10.5} fill="#7FBA00" />
      <Rect x={1} y={12.5} width={10.5} height={10.5} fill="#00A4EF" />
      <Rect x={12.5} y={12.5} width={10.5} height={10.5} fill="#FFB900" />
    </Svg>
  );
}

// ─── Login-knap ──────────────────────────────────────────────────────────────
// Den første synlige udbyder er primær (blæk-fyldt); resten står som stille
// konturer på arket. Spinneren afløser ikonet — ikke teksten — så knappen
// hverken hopper eller mister sit navn, mens den arbejder.

function ProviderButton({
  label,
  icon,
  primary,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  icon: React.ReactNode;
  primary: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const fg = primary ? papirColor.onInk : papirColor.ink;
  return (
    <ScaleButton
      scaleTo={0.97}
      haptic="light"
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: papirSpace.md,
        height: 56,
        borderRadius: papirRadius.lg,
        backgroundColor: primary ? papirColor.ink : papirColor.card,
        borderWidth: primary ? 0 : 1,
        borderColor: papirColor.line,
        opacity: disabled && !busy ? 0.45 : 1,
      }}
    >
      <View style={{ width: 18, alignItems: 'center' }}>
        {busy ? <ActivityIndicator size="small" color={fg} /> : icon}
      </View>
      <PaperText role="button" color={fg}>
        {label}
      </PaperText>
    </ScaleButton>
  );
}

// ─── Skærmen ─────────────────────────────────────────────────────────────────

/** Hvad du logger ind til — tre stille linjer, ikke en featureliste. */
const CAPABILITIES = [
  { Icon: Mail, text: 'Svar ligger klar, før du når at spørge' },
  { Icon: CalendarDays, text: 'Din dag, planlagt i ro og orden' },
  { Icon: Mic, text: 'Sig det højt — Zolva husker det for dig' },
] as const;

export function AuthSheet({ onClose }: Props) {
  const { signInWithApple, signInWithGoogle, signInWithMicrosoft, appleAvailable } = useAuth();
  const [busy, setBusy] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hello = useMemo(() => `${greeting(new Date())}.`, []);

  const run = async (id: ProviderId, fn: () => Promise<unknown>) => {
    if (busy) return;
    try {
      setBusy(id);
      setError(null);
      // The Google/Microsoft sign-in helpers do NOT throw — they return
      // { error } (see auth.ts). A user-cancelled browser flow returns
      // { data: null, error: null }: no success, no failure → stay open
      // silently. Only a real error gets surfaced.
      const result = (await fn()) as { data?: unknown; error?: unknown } | undefined;
      if (result && result.error) {
        if (__DEV__) console.warn('[auth-sheet] sign-in failed:', result.error);
        setError('Login mislykkedes. Prøv igen.');
        return;
      }
      if (result && result.data === null && result.error === null) {
        return; // user cancelled the browser flow — keep the sheet open, no scolding
      }
      onClose();
    } catch (err) {
      if (__DEV__) console.warn('[auth-sheet] sign-in failed:', err);
      setError('Login mislykkedes. Prøv igen.');
    } finally {
      setBusy(null);
    }
  };

  const providers: Array<{
    id: ProviderId;
    label: string;
    icon: (primary: boolean) => React.ReactNode;
    onPress: () => void;
    show: boolean;
  }> = [
    {
      id: 'apple',
      label: 'Fortsæt med Apple',
      show: appleAvailable,
      icon: (primary) => <AppleMark color={primary ? papirColor.onInk : papirColor.ink} />,
      onPress: () => run('apple', signInWithApple),
    },
    {
      id: 'google',
      label: 'Fortsæt med Google',
      show: true,
      icon: () => <GoogleMark />,
      onPress: () => run('google', signInWithGoogle),
    },
    {
      id: 'microsoft',
      label: 'Fortsæt med Microsoft',
      show: true,
      icon: () => <MicrosoftMark />,
      onPress: () => run('microsoft', signInWithMicrosoft),
    },
  ];
  const visible = providers.filter((p) => p.show);

  return (
    <View style={styles.root}>
      {/* Toplinje: brand-lockup til venstre, diskret "Luk" til højre. */}
      <View style={styles.topRow}>
        <Animated.View
          entering={FadeIn.duration(papirDuration.overlay)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: papirSpace.sm }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1.5, height: 12 }}>
            {[4, 8, 5, 9, 4].map((h, i) => (
              <View
                key={i}
                style={{ width: 2, height: h, borderRadius: 1, backgroundColor: papirColor.red }}
              />
            ))}
          </View>
          <PaperText role="eyebrow" color={papirColor.ink3}>
            Zolva
          </PaperText>
        </Animated.View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Luk"
          onPress={onClose}
          hitSlop={12}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <PaperText role="small" color={papirColor.ink3}>
            Luk
          </PaperText>
        </Pressable>
      </View>

      {/* Titelbladet: bølgen ånder, hilsenen sætter sig, linjerne følger. */}
      <View style={styles.hero}>
        <Animated.View entering={FadeIn.duration(700)}>
          <BreathingWave listening={busy !== null} />
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(120).duration(560).easing(Easing.out(Easing.quad))}>
          <PaperText style={styles.greeting} accessibilityRole="header">
            {hello}
          </PaperText>
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(260).duration(560).easing(Easing.out(Easing.quad))}>
          <PaperText role="bodySerif" color={papirColor.ink2} style={styles.tagline}>
            Din personlige assistent — mails, møder og noter, samlet på ét stykke papir.
          </PaperText>
        </Animated.View>
        <View style={styles.capabilities}>
          {CAPABILITIES.map(({ Icon, text }, i) => (
            <Animated.View
              key={text}
              entering={FadeInDown.delay(420 + i * 90).duration(480).easing(Easing.out(Easing.quad))}
              style={styles.capabilityRow}
            >
              <Icon size={15} color={papirColor.ink3} strokeWidth={1.8} />
              <PaperText role="small" color={papirColor.ink2}>
                {text}
              </PaperText>
            </Animated.View>
          ))}
        </View>
      </View>

      {/* Arket: ét hvidt kort bærer handlingerne. */}
      <Animated.View
        entering={FadeInUp.delay(300).duration(600).easing(Easing.out(Easing.cubic))}
        style={styles.sheet}
      >
        <View style={{ gap: papirSpace.md }}>
          {visible.map((p, i) => (
            <ProviderButton
              key={p.id}
              label={p.label}
              icon={p.icon(i === 0)}
              primary={i === 0}
              busy={busy === p.id}
              disabled={busy !== null}
              onPress={p.onPress}
            />
          ))}
        </View>
        {error ? (
          <Animated.View entering={FadeIn.duration(papirDuration.toggle)}>
            <PaperText role="small" color={papirColor.red} style={styles.error}>
              {error}
            </PaperText>
          </Animated.View>
        ) : null}
        <PaperText role="caption" color={papirColor.ink3} style={styles.trust}>
          Zolva læser kun det, du selv giver adgang til.
        </PaperText>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: papirColor.paper,
    paddingHorizontal: papirSpace.screen,
    paddingTop: 68,
    paddingBottom: 40,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    gap: papirSpace.lg,
  },
  greeting: {
    fontFamily: papirFont.displayLight,
    fontSize: 46,
    lineHeight: 52,
    letterSpacing: -0.6,
    color: papirColor.ink,
    marginTop: papirSpace.sm,
  },
  tagline: {
    maxWidth: 300,
  },
  capabilities: {
    gap: papirSpace.md,
    marginTop: papirSpace.sm,
  },
  capabilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: papirSpace.md,
  },
  sheet: {
    backgroundColor: papirColor.card,
    borderRadius: papirRadius.card,
    padding: papirSpace.lg,
    ...papirShadow.base,
  },
  error: {
    textAlign: 'center',
    marginTop: papirSpace.md,
  },
  trust: {
    textAlign: 'center',
    marginTop: papirSpace.base,
  },
});
