import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInUp,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { Stone } from '../components/Stone';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { useTheme } from '../design/useTheme';
import { useAuth } from '../lib/auth';
import { useIcloudConnected } from '../lib/hooks';
import * as gmail from '../lib/gmail';
import * as graph from '../lib/microsoft-graph';

// All non-theme literal values used by this screen, centralised so no
// component has to inline a colour/font/size/radius. Anything not derivable
// from the global theme (e.g. the vivid selection green, the JetBrains-mono
// eyebrow font, the screen-specific card surfaces) lives here in one map.
// (rev: hot-reload nudge after PAL strip refactor)
const ONBOARDING_LITERALS = {
  // Colours not present in the design tokens. Selection green is a deliberate
  // exception to direction G's no-green rule — it carries the "confirm"
  // meaning that ink/grey alone can't.
  selectionGreen:    '#22C55E',
  cardOnSurface:     'rgba(255,255,255,0.85)',
  cardRimSurface:    'rgba(255,255,255,0.85)',
  hairlineFaint:     'rgba(15,16,20,0.04)',
  white:             '#FFFFFF',
  // Progressive ink alphas used as inert states (disabled button, off-track,
  // unfilled progress segment). Theme has `t.line` at 0.08 but these need
  // distinct steps for layering, so they're declared once here.
  inkAlpha10:        'rgba(15,16,20,0.10)',
  inkAlpha16:        'rgba(15,16,20,0.16)',
  inkAlpha18:        'rgba(15,16,20,0.18)',
  // The screen uses JetBrains Mono for eyebrows; the global fonts map only
  // exposes Space-Grotesk, so we name the literal here once.
  monoEyebrow:       'JetBrainsMono_500Medium',
  // Step counts.
  totalSteps:        7,
} as const;

function usePal() {
  const { t, surface } = useTheme();
  return useMemo(
    () => ({
      paper:    t.paper,
      ink:      t.ink,
      ink2:     t.ink2,
      ink3:     t.ink3,
      ink4:     t.ink4,
      line:     t.line,
      lineSoft: ONBOARDING_LITERALS.hairlineFaint,
      accent:   t.today,                           // direction-aware warm cue
      green:    ONBOARDING_LITERALS.selectionGreen,
      inkTint:  surface.scrim,                     // selected-option backdrop
      cardOn:   ONBOARDING_LITERALS.cardOnSurface,
      cardOff:  surface.glass,
      cardRim:  ONBOARDING_LITERALS.cardRimSurface,
      white:    ONBOARDING_LITERALS.white,
    }),
    [t, surface],
  );
}

// Logos referenced by the Trust screen. Centralised so the import paths
// don't repeat across cards.
const LOGOS = {
  gmail: require('../../assets/logos/gmail.png'),
  outlook: require('../../assets/logos/outlook-mail.png'),
  icloud: require('../../assets/logos/apple.png'),
  gcal: require('../../assets/logos/google-calendar.png'),
  ocal: require('../../assets/logos/outlook-calendar.png'),
  gdrive: require('../../assets/logos/google-drive.png'),
  onedrive: require('../../assets/logos/onedrive.png'),
  slack: require('../../assets/logos/slack.png'),
  notion: require('../../assets/logos/notion.png'),
} as const;

type LogoKey = keyof typeof LOGOS;

// Shared state shape — the user's selections accumulate as they progress.
// Persisted to the parent at the end via onComplete.
export type OnboardingState = {
  diagnose: string[];
  vision: string | null;
  persona: { autonomy?: string; tone?: string; morning_brief?: string };
  connections: Partial<Record<string, boolean>>;
};

const INITIAL_STATE: OnboardingState = {
  diagnose: [],
  vision: null,
  persona: {},
  connections: {},
};

const TOTAL_STEPS = ONBOARDING_LITERALS.totalSteps;

// ───────────────────────────────────────────────────────────────────────────
// Type primitives
// ───────────────────────────────────────────────────────────────────────────

function Eyebrow({ children, color, style }: { children: React.ReactNode; color?: string; style?: object }) {
  const PAL = usePal();
  return (
    <Text
      style={[
        {
          fontFamily: Platform.select({ ios: ONBOARDING_LITERALS.monoEyebrow, default: ONBOARDING_LITERALS.monoEyebrow }),
          fontSize: 10.5,
          letterSpacing: 1.05,
          color: color ?? PAL.ink3,
          fontWeight: '600',
          textTransform: 'uppercase',
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

function H1({ children, style }: { children: React.ReactNode; style?: object }) {
  const PAL = usePal();
  const { fonts } = useTheme();
  return (
    <Text
      style={[
        {
          fontFamily: fonts.display,
          fontSize: 38,
          lineHeight: 40,
          letterSpacing: -1.7,
          color: PAL.ink,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

function H2({ children, style }: { children: React.ReactNode; style?: object }) {
  const PAL = usePal();
  const { fonts } = useTheme();
  return (
    <Text
      style={[
        {
          fontFamily: fonts.uiBold,
          fontSize: 30,
          lineHeight: 32,
          letterSpacing: -1.2,
          color: PAL.ink,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

function Body({ children, style }: { children: React.ReactNode; style?: object }) {
  const PAL = usePal();
  const { fonts } = useTheme();
  return (
    <Text
      style={[
        {
          fontFamily: fonts.ui,
          fontSize: 14.5,
          lineHeight: 21,
          color: PAL.ink2,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const PAL = usePal();
  const { fonts, radius } = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        paddingVertical: 15,
        paddingHorizontal: 22,
        borderRadius: radius.pill,
        backgroundColor: disabled ? ONBOARDING_LITERALS.inkAlpha18 : PAL.ink,
        alignItems: 'center',
        opacity: pressed && !disabled ? 0.85 : 1,
      })}
    >
      <Text
        style={{
          fontFamily: fonts.uiBold,
          fontSize: 14.5,
          color: PAL.white,
          letterSpacing: -0.15,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function CheckGlyph({ size = 12, color = ONBOARDING_LITERALS.white }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12">
      <Path
        d="M2.5 6.2 L5 8.5 L9.5 3.5"
        stroke={color}
        strokeWidth={1.8}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// Animated selection circle — when `on` flips true, the green fill springs
// from scale 0 → 1 from the center outward (inside-out), and the icon fades
// in just behind the spring's overshoot. Reverses cleanly on deselect.
// `kind` chooses the inner glyph: 'check' for multi/single-select cards,
// 'dot' for the radio-style personalisation cards.
function SelectionCircle({ on, kind = 'check', size = 22 }: { on: boolean; kind?: 'check' | 'dot'; size?: number }) {
  const PAL = usePal();
  const scale = useSharedValue(on ? 1 : 0);
  const iconOpacity = useSharedValue(on ? 1 : 0);

  React.useEffect(() => {
    scale.value = withSpring(on ? 1 : 0, { damping: 12, stiffness: 220, mass: 0.55 });
    // Icon trails the fill slightly so it lands just as the green stops
    // springing — feels like the check "appears" inside the bloom.
    iconOpacity.value = withTiming(on ? 1 : 0, { duration: on ? 220 : 140 });
  }, [on, scale, iconOpacity]);

  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: iconOpacity.value,
  }));

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size,
        borderWidth: 1.5,
        borderColor: on ? PAL.green : ONBOARDING_LITERALS.inkAlpha18,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFillObject,
          { borderRadius: size, backgroundColor: PAL.green },
          fillStyle,
        ]}
      />
      <Animated.View style={iconStyle}>
        {kind === 'check' ? (
          <CheckGlyph />
        ) : (
          <View style={{ width: 8, height: 8, borderRadius: 8, backgroundColor: PAL.white }} />
        )}
      </Animated.View>
    </View>
  );
}

// Same toggle pattern as Settings → Integrations: stock RN <Switch> with the
// app's success-green track. Trades the custom glass effect for parity with
// the rest of the connected-services UI.
function GlassToggle({
  on,
  onPress,
  accessibilityLabel,
}: {
  on: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const PAL = usePal();
  const trackOff = ONBOARDING_LITERALS.inkAlpha16;
  return (
    <Switch
      value={on}
      onValueChange={() => onPress?.()}
      trackColor={{ false: trackOff, true: PAL.green }}
      thumbColor={PAL.white}
      ios_backgroundColor={trackOff}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

function ChevLeft({ size = 14 }: { size?: number }) {
  const PAL = usePal();
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Path
        d="M10 3L5 8l5 5"
        stroke={PAL.ink}
        strokeWidth={1.6}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// Stagger helper — Reanimated entrance with a per-index delay so children
// cascade in. Mirrors the prototype's `animation: stagger(i)` CSS.
const STAGGER_BASE = 70;
const STAGGER_DURATION = 540;

// ───────────────────────────────────────────────────────────────────────────
// 1. Welcome
// ───────────────────────────────────────────────────────────────────────────

function ScreenWelcome({ next }: { next: () => void }) {
  const PAL = usePal();
  const { fonts } = useTheme();
  return (
    <View style={[styles.screen, { paddingHorizontal: 28 }]}>
      <Animated.View
        entering={FadeIn.delay(0).duration(STAGGER_DURATION)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4 }}
      >
        <Stone size={26} mood="calm" />
        <Text style={{ fontFamily: fonts.uiBold, fontSize: 17, letterSpacing: -0.5, color: PAL.ink }}>
          Zolva
        </Text>
      </Animated.View>

      <View style={{ flex: 1, justifyContent: 'center', gap: 22 }}>
        <Animated.View
          entering={FadeInUp.delay(STAGGER_BASE).duration(STAGGER_DURATION)}
          style={{ alignItems: 'center', marginBottom: 4 }}
        >
          <Stone size={88} mood="calm" />
        </Animated.View>

        <Animated.View entering={FadeInUp.delay(STAGGER_BASE * 2).duration(STAGGER_DURATION)} style={{ alignItems: 'center' }}>
          <Eyebrow color={PAL.ink2}>Velkommen ind</Eyebrow>
        </Animated.View>

        <Animated.View entering={FadeInUp.delay(STAGGER_BASE * 3).duration(STAGGER_DURATION)} style={{ alignItems: 'center' }}>
          <H1 style={{ textAlign: 'center', fontSize: 42, lineHeight: 44, letterSpacing: -2.1 }}>
            Lad mig lære{'\n'}dig at kende.
          </H1>
        </Animated.View>

        <Animated.View entering={FadeInUp.delay(STAGGER_BASE * 4).duration(STAGGER_DURATION)} style={{ alignItems: 'center' }}>
          <Body style={{ textAlign: 'center', fontSize: 15, maxWidth: 280, lineHeight: 22.5 }}>
            Det tager to minutter. Jeg stiller fem spørgsmål, så jeg ved hvor jeg skal kigge først.
          </Body>
        </Animated.View>
      </View>

      <Animated.View entering={FadeInUp.delay(STAGGER_BASE * 5).duration(STAGGER_DURATION)}>
        <PrimaryButton label="Lad os begynde →" onPress={next} />
        <Text
          style={{
            marginTop: 14,
            textAlign: 'center',
            fontFamily: ONBOARDING_LITERALS.monoEyebrow,
            fontSize: 10,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            color: PAL.ink3,
          }}
        >
          Du kan ændre alt senere · 7 dages prøve
        </Text>
      </Animated.View>
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Diagnose (multi-select)
// ───────────────────────────────────────────────────────────────────────────

const DIAGNOSE_OPTIONS = [
  { id: 'unanswered', t: 'Mails jeg burde have svaret på',          d: 'Tråde der ligger og lurer i indbakken.' },
  { id: 'meetings',   t: 'Møder der ikke giver mening',              d: 'Kalenderen er fuld, men dagen føles spildt.' },
  { id: 'followups',  t: 'Opfølgninger jeg har lovet',               d: 'Jeg sagde "jeg vender tilbage" og glemte det.' },
  { id: 'deadlines',  t: 'Deadlines der nærmer sig',                 d: 'Jeg ved de er der. Jeg ved ikke hvornår.' },
  { id: 'findfiles',  t: 'Information jeg ikke kan finde i mine filer', d: 'Jeg leder i 20 min for at finde noget jeg selv har skrevet.' },
];

function ScreenDiagnose({
  state,
  setState,
  next,
}: {
  state: OnboardingState;
  setState: (u: (s: OnboardingState) => OnboardingState) => void;
  next: () => void;
}) {
  const PAL = usePal();
  const { radius } = useTheme();
  const sel = state.diagnose;
  const toggle = (id: string) => {
    const ns = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
    setState((s) => ({ ...s, diagnose: ns }));
  };

  const cta =
    sel.length === 0
      ? 'Vælg mindst én'
      : `Fortsæt med ${sel.length} ${sel.length === 1 ? 'valgt' : 'valgte'} →`;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.screen, { paddingHorizontal: 22 }]}>
      <Animated.View entering={FadeInUp.duration(STAGGER_DURATION)} style={{ paddingTop: 10, paddingHorizontal: 2 }}>
        <Eyebrow color={PAL.ink2}>Trin 02 · diagnose</Eyebrow>
        <H2 style={{ marginTop: 12 }}>Hvad skal Zolva holde øje med først?</H2>
        <Body style={{ marginTop: 10, fontSize: 13.5, color: PAL.ink3, lineHeight: 19 }}>
          Vælg det der bekymrer dig mest. Du kan ændre det senere.
        </Body>
      </Animated.View>

      <View style={{ marginTop: 20, gap: 8 }}>
        {DIAGNOSE_OPTIONS.map((o, i) => {
          const on = sel.includes(o.id);
          return (
            <Animated.View
              key={o.id}
              entering={FadeInUp.delay(STAGGER_BASE * (i + 1)).duration(STAGGER_DURATION)}
            >
              <Pressable onPress={() => toggle(o.id)}>
                <View
                  style={{
                    padding: 14,
                    borderRadius: radius.cardSm,
                    borderWidth: 1,
                    borderColor: on ? PAL.ink : PAL.cardRim,
                    backgroundColor: on ? PAL.inkTint : PAL.cardOff,
                    flexDirection: 'row',
                    gap: 13,
                    alignItems: 'flex-start',
                  }}
                >
                  <View style={{ marginTop: 1 }}>
                    <SelectionCircle on={on} kind="check" size={22} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: '600', color: PAL.ink, letterSpacing: -0.21, lineHeight: 19 }}>
                      {o.t}
                    </Text>
                    <Text style={{ fontSize: 12.5, color: PAL.ink3, marginTop: 3, lineHeight: 17.5 }}>
                      {o.d}
                    </Text>
                  </View>
                  <Text
                    style={{
                      fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                      fontSize: 9.5,
                      letterSpacing: 0.95,
                      color: on ? PAL.ink : PAL.ink4,
                      marginTop: 3,
                      fontWeight: '600',
                    }}
                  >
                    0{i + 1}
                  </Text>
                </View>
              </Pressable>
            </Animated.View>
          );
        })}
      </View>

      <View style={{ flex: 1, minHeight: 12 }} />
      <Animated.View entering={FadeInUp.delay(STAGGER_BASE * 7).duration(STAGGER_DURATION)} style={{ marginTop: 18 }}>
        <PrimaryButton label={cta} onPress={next} disabled={sel.length === 0} />
      </Animated.View>
    </ScrollView>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Vision (single-select)
// ───────────────────────────────────────────────────────────────────────────

type VisionTone = 'primary' | 'muted';

const VISIONS: Array<{ id: string; eyebrow: string; num: string; t: string; d: string; tone: VisionTone }> = [
  { id: 'morning',  eyebrow: 'Morgener', num: 'i',
    t: '...jeg åbner mailen uden knude i maven.',
    d: 'Ingen panik. Jeg ved hvad der venter.', tone: 'primary' },
  { id: 'friday',   eyebrow: 'Fredage',  num: 'ii',
    t: '...jeg lukker fredag uden at have glemt noget.',
    d: 'Det vigtige er ordnet. Resten kan vente.', tone: 'muted' },
  { id: 'meetings', eyebrow: 'Møder',    num: 'iii',
    t: '...jeg går fra et møde og ved hvad næste skridt er.',
    d: 'Ingen tråde der falder mellem stolene.', tone: 'muted' },
  { id: 'findfast', eyebrow: 'Filer',    num: 'iv',
    t: '...jeg finder dokumenter på sekunder, ikke minutter.',
    d: 'Det jeg har skrevet, kan jeg finde igen.', tone: 'muted' },
];

function ScreenVision({
  state,
  setState,
  next,
}: {
  state: OnboardingState;
  setState: (u: (s: OnboardingState) => OnboardingState) => void;
  next: () => void;
}) {
  const PAL = usePal();
  const { fonts, radius } = useTheme();
  const sel = state.vision;
  const choose = (id: string) => setState((s) => ({ ...s, vision: id }));
  const toneColor = (tone: VisionTone) => (tone === 'primary' ? PAL.ink : PAL.ink3);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.screen, { paddingHorizontal: 22 }]}>
      <Animated.View entering={FadeInUp.duration(STAGGER_DURATION)} style={{ paddingTop: 10, paddingHorizontal: 2 }}>
        <Eyebrow color={PAL.ink2}>Trin 03 · forestil dig</Eyebrow>
        <H2 style={{ marginTop: 12 }}>Hvornår skal du mærke at det virker?</H2>
        <Body style={{ marginTop: 10, fontSize: 13.5, color: PAL.ink3, lineHeight: 19 }}>
          Vælg én. Det bliver din målestok de næste to uger.
        </Body>
      </Animated.View>

      <View style={{ marginTop: 18, gap: 10 }}>
        {VISIONS.map((v, i) => {
          const on = sel === v.id;
          const tColor = toneColor(v.tone);
          return (
            <Animated.View
              key={v.id}
              entering={FadeInUp.delay(STAGGER_BASE * (i + 1)).duration(STAGGER_DURATION)}
            >
              <Pressable onPress={() => choose(v.id)}>
                <View
                  style={{
                    padding: 16,
                    borderRadius: radius.cardSm,
                    borderWidth: 1,
                    borderColor: on ? tColor : PAL.cardRim,
                    backgroundColor: on ? PAL.cardOn : PAL.cardOff,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
                      <Text
                        style={{
                          fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                          fontWeight: '600',
                          fontSize: 11,
                          color: on ? tColor : PAL.ink3,
                          letterSpacing: 1.1,
                          textTransform: 'uppercase',
                        }}
                      >
                        {v.num}
                      </Text>
                      <Eyebrow color={on ? tColor : PAL.ink3}>{v.eyebrow}</Eyebrow>
                    </View>
                    <SelectionCircle on={on} kind="check" size={22} />
                  </View>
                  <Text
                    style={{
                      fontFamily: fonts.ui,
                      fontSize: 17.5,
                      lineHeight: 22,
                      letterSpacing: -0.44,
                      color: PAL.ink,
                    }}
                  >
                    {v.t}
                  </Text>
                  <Text style={{ fontSize: 12.5, color: PAL.ink3, marginTop: 8, lineHeight: 18.75 }}>
                    {v.d}
                  </Text>
                </View>
              </Pressable>
            </Animated.View>
          );
        })}
      </View>

      <View style={{ flex: 1, minHeight: 12 }} />
      <Animated.View entering={FadeInUp.delay(STAGGER_BASE * 5).duration(STAGGER_DURATION)} style={{ marginTop: 18 }}>
        <PrimaryButton label={sel ? 'Det her vil jeg →' : 'Vælg en'} onPress={next} disabled={!sel} />
      </Animated.View>
    </ScrollView>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Personalisation (two sub-questions, auto-advance)
// ───────────────────────────────────────────────────────────────────────────

const PERSONA_QUESTIONS = [
  {
    key: 'autonomy', eyebrow: 'Autonomi', q: 'Hvor meget må Zolva gøre selv?',
    opts: [
      { id: 'ask',   t: 'Spørg mig først', d: 'Jeg vil se alt før det sker.' },
      { id: 'draft', t: 'Lav udkast',     d: 'Jeg trykker send, hvis det ser rigtigt ud.' },
      { id: 'act',   t: 'Bare ordn det',  d: 'Vis mig hvad der skete bagefter.' },
    ],
  },
  {
    key: 'tone', eyebrow: 'Tone', q: 'Hvordan skriver du selv?',
    opts: [
      { id: 'short',  t: 'Kort og direkte',     d: 'To linjer. Ingen smalltalk.' },
      { id: 'warm',   t: 'Venlig og afslappet',  d: 'Du-form, lidt smalltalk, høflig.' },
      { id: 'formal', t: 'Professionel ramme',   d: 'De-form, fuld høflig form.' },
    ],
  },
] as const;

function ScreenPersonalisation({
  state,
  setState,
  next,
}: {
  state: OnboardingState;
  setState: (u: (s: OnboardingState) => OnboardingState) => void;
  next: () => void;
}) {
  const PAL = usePal();
  const { radius } = useTheme();
  const [step, setStep] = useState(0);
  const cur = PERSONA_QUESTIONS[step];
  const persona = state.persona;
  const selected = persona[cur.key as 'autonomy' | 'tone'];

  const choose = (id: string) => {
    const np = { ...persona, [cur.key]: id, morning_brief: persona.morning_brief ?? '0800' };
    setState((s) => ({ ...s, persona: np }));
    setTimeout(() => {
      if (step < PERSONA_QUESTIONS.length - 1) setStep(step + 1);
      else next();
    }, 300);
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.screen, { paddingHorizontal: 22 }]}>
      <Animated.View entering={FadeInUp.duration(STAGGER_DURATION)} style={{ paddingTop: 10, paddingHorizontal: 2 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Eyebrow color={PAL.ink2}>Trin 04 · personalisering</Eyebrow>
          <Text
            style={{
              fontFamily: ONBOARDING_LITERALS.monoEyebrow,
              fontSize: 10.5,
              letterSpacing: 1.05,
              color: PAL.ink3,
              fontWeight: '600',
            }}
          >
            {String(step + 1).padStart(2, '0')}
            <Text style={{ opacity: 0.4 }}>/{String(PERSONA_QUESTIONS.length).padStart(2, '0')}</Text>
          </Text>
        </View>
        <H2 style={{ marginTop: 12, fontSize: 28, lineHeight: 30 }}>{cur.q}</H2>
        <View
          style={{
            marginTop: 10,
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 4,
            paddingLeft: 8,
            paddingRight: 12,
            borderRadius: radius.pill,
            backgroundColor: PAL.cardOff,
            borderWidth: 1,
            borderColor: PAL.cardRim,
          }}
        >
          <View style={{ width: 5, height: 5, borderRadius: 5, backgroundColor: PAL.ink }} />
          <Text style={{ fontSize: 11.5, color: PAL.ink2, fontWeight: '600', letterSpacing: -0.06 }}>
            {cur.eyebrow}
          </Text>
        </View>
      </Animated.View>

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 18 }}>
        {PERSONA_QUESTIONS.map((_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 3,
              backgroundColor: i < step ? PAL.ink : i === step ? PAL.accent : ONBOARDING_LITERALS.inkAlpha10,
            }}
          />
        ))}
      </View>

      <Animated.View
        key={cur.key}
        entering={FadeIn.duration(STAGGER_DURATION)}
        exiting={FadeOutDown.duration(220)}
        style={{ marginTop: 18, gap: 10 }}
      >
        {cur.opts.map((o, i) => {
          const on = selected === o.id;
          return (
            <Animated.View
              key={o.id}
              entering={FadeInUp.delay(STAGGER_BASE * (i + 1)).duration(STAGGER_DURATION)}
            >
              <Pressable onPress={() => choose(o.id)}>
                <View
                  style={{
                    padding: 14,
                    paddingHorizontal: 18,
                    borderRadius: radius.cardSm,
                    borderWidth: 1,
                    borderColor: on ? PAL.ink : PAL.cardRim,
                    backgroundColor: on ? PAL.inkTint : PAL.cardOff,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: PAL.ink, letterSpacing: -0.225 }}>
                      {o.t}
                    </Text>
                    <Text style={{ fontSize: 12.5, color: PAL.ink3, marginTop: 3, lineHeight: 17.5 }}>
                      {o.d}
                    </Text>
                  </View>
                  <SelectionCircle on={on} kind="dot" size={20} />
                </View>
              </Pressable>
            </Animated.View>
          );
        })}
      </Animated.View>

      <View style={{ flex: 1 }} />
      <View
        style={{
          marginTop: 18,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <Svg width={11} height={11} viewBox="0 0 11 11">
          <Path
            d="M2 5.5 L4.5 8 L9 3"
            stroke={PAL.ink3}
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
        <Text
          style={{
            fontFamily: ONBOARDING_LITERALS.monoEyebrow,
            fontSize: 10,
            letterSpacing: 1,
            textTransform: 'uppercase',
            color: PAL.ink3,
            fontWeight: '500',
          }}
        >
          Tryk for at vælge, vi går videre selv
        </Text>
      </View>
    </ScrollView>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Expectation (timeline)
// ───────────────────────────────────────────────────────────────────────────

function getFirstBriefText() {
  const hour = new Date().getHours();
  if (hour < 11) {
    return {
      d: 'I dag, om lidt',
      t: 'Din første brief er klar inden for en time. Den bygger på det jeg kan læse fra dag 1.',
    };
  }
  if (hour < 17) {
    return {
      d: 'I morgen tidlig',
      t: 'Din første brief lander 08.00. Du kan også åbne den manuelt nu hvis du er nysgerrig.',
    };
  }
  return {
    d: 'I morgen tidlig',
    t: 'Din første brief lander 08.00. Den bygger på det jeg kan læse fra dag 1.',
  };
}

function ScreenExpectation({ next }: { next: () => void }) {
  const PAL = usePal();
  const { radius } = useTheme();
  const firstBrief = getFirstBriefText();
  const timeline = [
    { d: firstBrief.d, t: firstBrief.t,                                                     dot: PAL.accent },
    { d: 'Dag 2–3',    t: 'Jeg lærer dine kontakter, mønstre og typiske svartider.',         dot: PAL.ink3 },
    { d: 'Uge 1',      t: 'Briefene bliver bedre. Jeg fanger flere nuancer i hvad der haster.', dot: PAL.ink3 },
    { d: 'Uge 2',      t: 'Udkast lyder mere og mere som dig.',                              dot: PAL.ink3 },
  ];

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.screen, { paddingHorizontal: 22 }]}>
      <Animated.View entering={FadeInUp.duration(STAGGER_DURATION)} style={{ paddingTop: 10, alignItems: 'center' }}>
        <Stone size={64} mood="thinking" />
      </Animated.View>

      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE).duration(STAGGER_DURATION)}
        style={{ marginTop: 18, paddingHorizontal: 2 }}
      >
        <Eyebrow color={PAL.ink2}>Trin 05 · forventning</Eyebrow>
        <H2 style={{ marginTop: 12 }}>De første dage lærer jeg dig at kende.</H2>
      </Animated.View>

      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE * 2).duration(STAGGER_DURATION)}
        style={{ marginTop: 14, paddingHorizontal: 2 }}
      >
        <Body style={{ fontSize: 14.5, lineHeight: 22.5 }}>
          Zolva bliver bedre uge for uge. De første 3 til 5 dage handler om at fange mønstre i hvordan du arbejder. Du kan rette i alt undervejs.
        </Body>
      </Animated.View>

      <Animated.View entering={FadeInUp.delay(STAGGER_BASE * 3).duration(STAGGER_DURATION)} style={{ marginTop: 22 }}>
        <GlassFrostedCard radius={radius.cardSm} style={{ paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12 }}>
          <View style={{ width: 3, alignSelf: 'stretch', backgroundColor: PAL.ink, borderRadius: 3 }} />
          <Body style={{ fontSize: 13.5, color: PAL.ink, lineHeight: 20.25, flex: 1 }}>
            Du behøver ikke gøre noget aktivt. Brug appen som du plejer at bruge mail og kalender.
          </Body>
        </GlassFrostedCard>
      </Animated.View>

      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE * 4).duration(STAGGER_DURATION)}
        style={{ marginTop: 22 }}
      >
        <GlassFrostedCard radius={radius.cardSm} style={{ paddingVertical: 16, paddingHorizontal: 16 }}>
          <Eyebrow style={{ marginBottom: 12 }}>Det her sker</Eyebrow>
          {timeline.map((row, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 12, paddingTop: i === 0 ? 0 : 10 }}>
              <View style={{ width: 14, alignItems: 'center', position: 'relative' }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 8,
                    backgroundColor: row.dot,
                    marginTop: 5,
                  }}
                />
                {i < timeline.length - 1 && (
                  <View
                    style={{
                      position: 'absolute',
                      top: 14,
                      bottom: -10,
                      width: 1,
                      backgroundColor: PAL.line,
                    }}
                  />
                )}
              </View>
              <Text
                style={{
                  width: 96,
                  fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                  fontSize: 10.5,
                  letterSpacing: 0.63,
                  textTransform: 'uppercase',
                  color: PAL.ink3,
                  fontWeight: '600',
                  paddingTop: 1,
                }}
              >
                {row.d}
              </Text>
              <Text style={{ flex: 1, fontSize: 13, color: PAL.ink2, lineHeight: 18.85 }}>{row.t}</Text>
            </View>
          ))}
        </GlassFrostedCard>
      </Animated.View>

      <View style={{ flex: 1, minHeight: 18 }} />
      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE * 5).duration(STAGGER_DURATION)}
        style={{ marginTop: 18 }}
      >
        <PrimaryButton label="Det giver mening →" onPress={next} />
      </Animated.View>
    </ScrollView>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Trust / Connect
// ───────────────────────────────────────────────────────────────────────────

const ACTIVE_SOURCES: Array<{ id: LogoKey; name: string; detail: string }> = [
  { id: 'gmail',    name: 'Gmail',            detail: 'Læser tråde, foreslår svar, skriver udkast.' },
  { id: 'outlook',  name: 'Outlook',          detail: 'Læser tråde, foreslår svar, skriver udkast.' },
  { id: 'icloud',   name: 'Apple Mail',       detail: 'Læser iCloud-mails via app-specific password.' },
  { id: 'gcal',     name: 'Google Calendar',  detail: 'Ser dine møder, foreslår tidspunkter, rydder op.' },
  { id: 'ocal',     name: 'Outlook Calendar', detail: 'Ser dine møder, foreslår tidspunkter, rydder op.' },
  { id: 'gdrive',   name: 'Google Drive',     detail: 'Åbner kun de filer du selv nævner i chat.' },
  { id: 'onedrive', name: 'OneDrive',         detail: 'Åbner kun de filer du selv nævner i chat.' },
];

const SOON_SOURCES: Array<{ id: LogoKey; name: string; detail: string }> = [
  { id: 'slack',  name: 'Slack',  detail: 'Læser kanaler du følger, opsummerer tråde.' },
  { id: 'notion', name: 'Notion', detail: 'Læser sider, finder noter, opdaterer status.' },
];

const PRINCIPLES = [
  'Jeg gemmer ingen kopier af dine mails.',
  'Du kan altid se hvad jeg har gjort, og fortryde det.',
  'Du kan slukke for hver kilde individuelt, til enhver tid.',
];

function SourceCard({
  id,
  name,
  detail,
  isOn,
  busy,
  onToggle,
  soon,
  index,
}: {
  id: LogoKey;
  name: string;
  detail: string;
  isOn: boolean;
  busy?: boolean;
  onToggle?: () => void;
  soon?: boolean;
  index: number;
}) {
  const PAL = usePal();
  const { fonts, radius } = useTheme();
  return (
    <Animated.View entering={FadeInUp.delay(STAGGER_BASE * (index + 1)).duration(STAGGER_DURATION)}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          padding: 13,
          borderRadius: radius.cardSm,
          borderWidth: 1,
          borderColor: isOn ? PAL.ink : PAL.cardRim,
          backgroundColor: isOn ? PAL.cardOn : PAL.cardOff,
          opacity: soon ? 0.55 : 1,
        }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: PAL.white,
            borderWidth: 1,
            borderColor: PAL.lineSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Image source={LOGOS[id]} style={{ width: 28, height: 28, resizeMode: 'contain' }} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.uiBold, fontSize: 14.5, color: PAL.ink, letterSpacing: -0.145 }}>
            {name}
          </Text>
          <Text style={{ fontSize: 12, color: PAL.ink3, marginTop: 2, lineHeight: 16.8 }}>
            {detail}
          </Text>
        </View>
        {soon ? (
          <View
            style={{
              borderWidth: 1,
              borderColor: PAL.line,
              borderRadius: radius.pill,
              paddingVertical: 4,
              paddingHorizontal: 10,
            }}
          >
            <Text
              style={{
                fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                fontSize: 9.5,
                letterSpacing: 1.14,
                textTransform: 'uppercase',
                color: PAL.ink3,
                fontWeight: '600',
              }}
            >
              Snart
            </Text>
          </View>
        ) : busy ? (
          <ActivityIndicator color={PAL.ink2} />
        ) : (
          <GlassToggle
            on={isOn}
            onPress={onToggle}
            accessibilityLabel={`${isOn ? 'Frakobl' : 'Forbind'} ${name}`}
          />
        )}
      </View>
    </Animated.View>
  );
}

// Each source card maps to a single OAuth provider family. Google covers
// gmail/calendar/drive; Microsoft covers outlook/calendar/onedrive. Tapping
// a source's toggle authorizes the provider once per family — subsequent
// toggles within the same family flip a local "intent" flag without firing
// another sign-in.
const PROVIDER_BY_SOURCE: Record<string, 'google' | 'microsoft'> = {
  gmail: 'google',
  gcal: 'google',
  gdrive: 'google',
  outlook: 'microsoft',
  ocal: 'microsoft',
  onedrive: 'microsoft',
};

function ScreenTrust({
  state,
  setState,
  next,
  onOpenIcloudSetup,
}: {
  state: OnboardingState;
  setState: (u: (s: OnboardingState) => OnboardingState) => void;
  next: () => void;
  onOpenIcloudSetup?: () => void;
}) {
  const PAL = usePal();
  const { radius } = useTheme();
  const { user, googleAccessToken, microsoftAccessToken, signInWithGoogle, signInWithMicrosoft } = useAuth();
  // Identities is the source of truth for "is this provider linked at
  // Supabase". Reading the in-memory access-token cache instead would let
  // a transient silentRefresh failure fire runOAuth on an already-linked
  // identity, which calls unlinkIdentity and revokes EVERY refresh token
  // for the user (see auth.ts:647-651).
  const googleLinked = !!user?.identities?.some((i) => i.provider === 'google');
  const microsoftLinked = !!user?.identities?.some((i) => i.provider === 'azure');
  const [busyId, setBusyId] = useState<string | null>(null);
  // Watch iCloud credential state. Setup happens in a sibling modal
  // (IcloudSetupScreen) opened via onOpenIcloudSetup; once the credential
  // lands the hook flips and we mirror the change into onboarding state
  // so the toggle visibly turns ON without the user retapping.
  const icloudConnected = useIcloudConnected(user?.id ?? '');
  useEffect(() => {
    if (!icloudConnected) return;
    setState((s) => {
      if (s.connections?.icloud === true) return s;
      return { ...s, connections: { ...(s.connections ?? {}), icloud: true } };
    });
  }, [icloudConnected, setState]);

  const conn = state.connections;

  const handleToggle = async (id: string) => {
    const isOn = !!conn[id];
    if (isOn) {
      // Turning off only clears local intent — we don't revoke the OAuth
      // grant or iCloud credential mid-onboarding. The user can fully
      // disconnect from Settings.
      setState((s) => ({ ...s, connections: { ...(s.connections ?? {}), [id]: false } }));
      return;
    }

    // iCloud uses an app-specific password, not OAuth. Hand off to the
    // sibling IcloudSetupScreen modal; the useIcloudConnected effect
    // above flips the toggle on once the credential is saved.
    if (id === 'icloud') {
      onOpenIcloudSetup?.();
      return;
    }

    const provider = PROVIDER_BY_SOURCE[id];
    const grantPresent =
      provider === 'google'
        ? googleLinked || !!googleAccessToken
        : microsoftLinked || !!microsoftAccessToken;

    if (grantPresent) {
      setState((s) => ({ ...s, connections: { ...(s.connections ?? {}), [id]: true } }));
      return;
    }

    // No token yet — fire OAuth. On success, set this source's flag on. We
    // intentionally do not auto-flip sibling sources (e.g. enabling Gmail
    // shouldn't also enable Calendar) — the user's per-source intent is
    // what we persist.
    try {
      setBusyId(id);
      if (provider === 'google') await signInWithGoogle();
      else await signInWithMicrosoft();
      setState((s) => ({ ...s, connections: { ...(s.connections ?? {}), [id]: true } }));
    } catch (err) {
      if (__DEV__) console.warn('[onboarding-flow] OAuth failed:', err);
    } finally {
      setBusyId(null);
    }
  };

  const count = ACTIVE_SOURCES.filter((a) => conn[a.id]).length;
  const cta = count === 0 ? 'Vælg mindst én kilde' : count === 1 ? 'Fortsæt med 1 kilde →' : `Fortsæt med ${count} kilder →`;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.screen, { paddingHorizontal: 22 }]}>
      <Animated.View entering={FadeInUp.duration(STAGGER_DURATION)} style={{ paddingTop: 10, paddingHorizontal: 2 }}>
        <Eyebrow color={PAL.ink2}>Trin 06 · forbind</Eyebrow>
        <H2 style={{ marginTop: 12 }}>Hvad vil du give mig adgang til?</H2>
        <Body style={{ marginTop: 10, fontSize: 13.5, color: PAL.ink3, lineHeight: 19 }}>
          Vælg det du bruger. Du kan tilføje eller fjerne kilder senere.
        </Body>
      </Animated.View>

      <View style={{ marginTop: 20, gap: 10 }}>
        {ACTIVE_SOURCES.map((s, i) => (
          <SourceCard
            key={s.id}
            id={s.id}
            name={s.name}
            detail={s.detail}
            isOn={!!conn[s.id]}
            busy={busyId === s.id}
            onToggle={() => { void handleToggle(s.id); }}
            index={i}
          />
        ))}
      </View>

      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE * 7).duration(STAGGER_DURATION)}
        style={{ marginTop: 22, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <View style={{ flex: 1, height: 1, backgroundColor: PAL.line }} />
        <Text
          style={{
            fontFamily: ONBOARDING_LITERALS.monoEyebrow,
            fontSize: 10,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            color: PAL.ink3,
            fontWeight: '600',
          }}
        >
          Kommer snart
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: PAL.line }} />
      </Animated.View>

      <View style={{ gap: 10 }}>
        {SOON_SOURCES.map((s, i) => (
          <SourceCard key={s.id} id={s.id} name={s.name} detail={s.detail} isOn={false} soon index={i + 7} />
        ))}
      </View>

      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE * 10).duration(STAGGER_DURATION)}
        style={{ marginTop: 22 }}
      >
        <GlassFrostedCard radius={radius.cardSm} style={{ paddingVertical: 14, paddingHorizontal: 16 }}>
          <Text
            style={{
              fontFamily: ONBOARDING_LITERALS.monoEyebrow,
              fontSize: 10,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              color: PAL.ink2,
              marginBottom: 10,
              fontWeight: '700',
            }}
          >
            Mine tre principper
          </Text>
          {PRINCIPLES.map((line, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                gap: 8,
                paddingTop: i === 0 ? 0 : 8,
              }}
            >
              <Text
                style={{
                  width: 20,
                  fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                  fontSize: 11,
                  color: PAL.ink,
                  fontWeight: '700',
                }}
              >
                {i + 1}.
              </Text>
              <Text style={{ flex: 1, fontSize: 13, lineHeight: 19.5, color: PAL.ink }}>{line}</Text>
            </View>
          ))}
        </GlassFrostedCard>
      </Animated.View>

      <View style={{ flex: 1, minHeight: 18 }} />
      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE * 11).duration(STAGGER_DURATION)}
        style={{ marginTop: 18 }}
      >
        <PrimaryButton label={cta} onPress={next} disabled={count === 0} />
        <Text
          style={{
            marginTop: 12,
            textAlign: 'center',
            fontFamily: ONBOARDING_LITERALS.monoEyebrow,
            fontSize: 10,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            color: PAL.ink3,
            lineHeight: 15,
            fontWeight: '500',
          }}
        >
          Du logger ind hos hver tjeneste via OAuth.{'\n'}Adgangen kan trækkes tilbage i indstillinger.
        </Text>
      </Animated.View>
    </ScrollView>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 7. Activation (sample brief)
// ───────────────────────────────────────────────────────────────────────────

type BriefTag = 'HASTER' | 'BESVAR' | 'HUSK';
type BriefItem = { id: string; tag: BriefTag | string; title: string; detail: string; time: string; tone: 'accent' | 'muted' };

// Demo data shown while the live fetch is in flight or when no provider is
// connected. Three items mirror the typical brief so the empty/loading
// states still convey the shape.
const SAMPLE_BRIEF: BriefItem[] = [
  { id: 's1', tag: 'HASTER', title: 'Marie venter på kontrakten',  detail: 'Tråden ligger og lurer fra i går.',                  time: 'I går',  tone: 'accent' },
  { id: 's2', tag: 'BESVAR', title: 'Jonas spørger om fakturaen',  detail: 'Kort spørgsmål — du sagde du vendte tilbage.',        time: 'I går',  tone: 'muted'  },
  { id: 's3', tag: 'HUSK',   title: 'Lene foreslår et mødetidspunkt', detail: 'Hun lagde tre forslag, du har ikke valgt et.',     time: 'I dag',  tone: 'muted'  },
];

// Same no-reply / marketing / no-action filters that the inbox classifier
// uses, copied here to keep the activation screen independent from the full
// classifier pipeline (which expects user prefs, draft cache, etc).
const NO_REPLY_PATTERN =
  /noreply|no-reply|no_reply|donotreply|do-not-reply|mailer-daemon|bounce@|newsletter|marketing|notification|alert|updates?@|news@|info@|chess\.com|stripe\.com|github\.com|linkedin\.com|reply@|automated|automatic|unsubscribe|@accounts\.google\.com/i;

const NON_REPLY_BODY_PATTERN =
  /(view (this|the|your) (email|message)|click (here )?to (verify|activate|confirm|reset|view|unsubscribe)|unsubscribe|verify your (email|account)|reset your password|se (mailen|denne mail) (i (din )?browser|online)|klik her for at (bekræfte|aktivere|nulstille|afmelde)|nulstil (din )?adgangskode|du modtager denne (mail|besked))/i;

const URGENCY_SUBJECT_PATTERN = /\b(haster|akut|vigtigt|frist|sidste chance|urgent|asap|important|deadline|reminder)\b/i;

// Subjects that read like a question or commitment-request — used to tag
// tier-1 mails as BESVAR vs HUSK. Questions/asks → BESVAR; everything else
// human-looking falls back to HUSK ("don't forget this thread").
const ASK_SUBJECT_PATTERN = /(\?|spørgsmål|spørg|kan du|vil du|please|kunne|kan vi)/i;

function classifyForBrief(opts: {
  from: string;
  subject: string;
  preview: string;
}): BriefTag | null {
  if (NO_REPLY_PATTERN.test(opts.from)) return null;
  if (NON_REPLY_BODY_PATTERN.test(opts.preview.slice(0, 800))) return null;
  if (URGENCY_SUBJECT_PATTERN.test(opts.subject)) return 'HASTER';
  if (ASK_SUBJECT_PATTERN.test(opts.subject)) return 'BESVAR';
  return 'HUSK';
}

// Greeting shifts with time of day so the demo brief feels live instead of
// always showing "God morgen" at 8pm.
function timeBasedGreeting(hour: number): string {
  if (hour < 5)  return 'God nat.';
  if (hour < 12) return 'God morgen.';
  if (hour < 18) return 'God dag.';
  return 'God aften.';
}

function formatHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}

// Coarse "I dag / I går / 3 dage siden" relative-time formatter — same
// granularity the rest of the app uses for inbox rows.
function relativeDay(d: Date, now: Date): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfThat) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return 'I dag';
  if (diffDays === 1) return 'I går';
  if (diffDays < 7)  return `${diffDays} dage siden`;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
}

// Trim Gmail/Graph snippet to a one-line preview. Both APIs return short
// previews already but Gmail can include HTML entities.
function tidySnippet(raw: string): string {
  const decoded = raw
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded.length > 100 ? `${decoded.slice(0, 97)}…` : decoded;
}

// We always want one of each tag in the brief: a HASTER, a BESVAR, a HUSK.
// Pulling three of the same kind makes the demo feel flat, even if the
// inbox really does have three urgent threads. The display order on screen
// is fixed HASTER → BESVAR → HUSK so the user reads "what's burning" first.
const TAG_DISPLAY_ORDER: BriefTag[] = ['HASTER', 'BESVAR', 'HUSK'];

type ScoredItem = BriefItem & { sortDate: number };

// Picks one item per tag (newest in tag), then back-fills empty tag slots
// with the next-best item from any other tag so we always return up to 3.
function diversifyByTag(scored: ScoredItem[]): BriefItem[] {
  const byTag = new Map<BriefTag, ScoredItem[]>();
  for (const item of scored) {
    const tag = item.tag as BriefTag;
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(item);
  }
  // Newest-first within each tag.
  for (const list of byTag.values()) list.sort((a, b) => b.sortDate - a.sortDate);

  const picked: ScoredItem[] = [];
  const usedIds = new Set<string>();
  // First pass — one per tag in display order.
  for (const tag of TAG_DISPLAY_ORDER) {
    const head = byTag.get(tag)?.[0];
    if (head) {
      picked.push(head);
      usedIds.add(head.id);
    }
  }
  // Second pass — fill remaining slots with the freshest unused items,
  // still preferring HASTER → BESVAR → HUSK.
  if (picked.length < 3) {
    const remaining: ScoredItem[] = [];
    for (const tag of TAG_DISPLAY_ORDER) {
      const list = byTag.get(tag) ?? [];
      for (const it of list) if (!usedIds.has(it.id)) remaining.push(it);
    }
    for (const it of remaining) {
      if (picked.length >= 3) break;
      picked.push(it);
      usedIds.add(it.id);
    }
  }
  return picked
    .sort(
      (a, b) =>
        TAG_DISPLAY_ORDER.indexOf(a.tag as BriefTag) -
          TAG_DISPLAY_ORDER.indexOf(b.tag as BriefTag) ||
        b.sortDate - a.sortDate,
    )
    .map(({ sortDate: _sortDate, ...rest }) => rest);
}

function gmailToBriefItems(msgs: gmail.GmailMessage[], now: Date): BriefItem[] {
  const scored: ScoredItem[] = [];
  for (const m of msgs) {
    const tag = classifyForBrief({ from: m.from, subject: m.subject, preview: m.snippet });
    if (!tag) continue;
    scored.push({
      id: m.id,
      tag,
      title: m.subject?.trim() || '(uden emne)',
      detail: m.from || tidySnippet(m.snippet ?? ''),
      time: relativeDay(m.date, now),
      tone: tag === 'HASTER' ? 'accent' : 'muted',
      sortDate: m.date.getTime(),
    });
  }
  return diversifyByTag(scored);
}

function graphToBriefItems(msgs: graph.GraphMessage[], now: Date): BriefItem[] {
  const scored: ScoredItem[] = [];
  for (const m of msgs) {
    const tag = classifyForBrief({ from: m.from, subject: m.subject, preview: m.preview });
    if (!tag) continue;
    scored.push({
      id: m.id,
      tag,
      title: m.subject?.trim() || '(uden emne)',
      detail: m.from || tidySnippet(m.preview ?? ''),
      time: relativeDay(m.receivedAt, now),
      tone: tag === 'HASTER' ? 'accent' : 'muted',
      sortDate: m.receivedAt.getTime(),
    });
  }
  return diversifyByTag(scored);
}

function summariseTagCounts(items: BriefItem[]): string {
  if (items.length === 0) return 'Indbakken er stille';
  const haster = items.filter((i) => i.tag === 'HASTER').length;
  const besvar = items.filter((i) => i.tag === 'BESVAR').length;
  const husk   = items.filter((i) => i.tag === 'HUSK').length;
  const parts: string[] = [];
  if (haster) parts.push(`${haster} haster`);
  if (besvar) parts.push(`${besvar} at besvare`);
  if (husk)   parts.push(`${husk} at huske`);
  return parts.join(' · ');
}

function ScreenActivation({ next }: { next: () => void }) {
  const PAL = usePal();
  const { fonts, radius } = useTheme();
  const { googleAccessToken, microsoftAccessToken } = useAuth();
  const briefToneColor = (tone: 'accent' | 'muted') => (tone === 'accent' ? PAL.accent : PAL.ink3);

  // Live brief from the provider the user just connected. While we're
  // fetching (or if neither token is present) we fall back to the demo
  // SAMPLE_BRIEF so the screen never shows an empty card.
  const [items, setItems] = useState<BriefItem[]>(SAMPLE_BRIEF);
  const [isDemo, setIsDemo] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const provider: 'google' | 'microsoft' | null =
      googleAccessToken ? 'google' : microsoftAccessToken ? 'microsoft' : null;
    if (!provider) return;

    setLoading(true);
    const now = new Date();
    (async () => {
      try {
        // Pull a wider window than the brief shows — the classifier drops
        // chess.com/marketing/no-reply senders, so we need a candidate
        // pool of ~20 to reliably surface 3 actionable mails.
        const msgs = provider === 'google'
          ? await gmail.listInboxMessages(20)
          : await graph.listInboxMessages(20);
        if (cancelled) return;
        const mapped = provider === 'google'
          ? gmailToBriefItems(msgs as gmail.GmailMessage[], now)
          : graphToBriefItems(msgs as graph.GraphMessage[], now);
        if (mapped.length > 0) {
          setItems(mapped);
          setIsDemo(false);
        }
      } catch (err) {
        if (__DEV__) console.warn('[onboarding-activation] live brief fetch failed:', err);
        // Stay on demo data — better than a broken card.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [googleAccessToken, microsoftAccessToken]);

  const briefMeta = useMemo(() => {
    const now = new Date();
    const subtitle = isDemo
      ? `${SAMPLE_BRIEF.length} ting der venter`
      : summariseTagCounts(items);
    return {
      greeting: timeBasedGreeting(now.getHours()),
      subtitle,
      stamp: formatHHMM(now),
    };
  }, [isDemo, items]);
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.screen, { paddingHorizontal: 22 }]}>
      <Animated.View entering={FadeInUp.duration(STAGGER_DURATION)} style={{ paddingTop: 10, paddingHorizontal: 2 }}>
        <Eyebrow color={PAL.ink2}>Trin 07 · klar</Eyebrow>
        <H1 style={{ marginTop: 12, fontSize: 36, lineHeight: 38 }}>
          Din første brief{'\n'}er klar.
        </H1>
      </Animated.View>

      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE).duration(STAGGER_DURATION)}
        style={{ marginTop: 22 }}
      >
        <GlassFrostedCard radius={radius.card} style={{ overflow: 'hidden' }}>
          <View
            style={{
              padding: 14,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottomWidth: 1,
              borderBottomColor: PAL.lineSoft,
              backgroundColor: PAL.lineSoft,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Stone size={32} mood="calm" />
              <View>
                <Text
                  style={{
                    fontFamily: fonts.uiBold,
                    fontSize: 17,
                    color: PAL.ink,
                    lineHeight: 19,
                    letterSpacing: -0.51,
                  }}
                >
                  {briefMeta.greeting}
                </Text>
                <Text
                  style={{
                    fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                    fontSize: 9.5,
                    letterSpacing: 1.14,
                    textTransform: 'uppercase',
                    color: PAL.ink2,
                    marginTop: 2,
                    fontWeight: '700',
                  }}
                >
                  {briefMeta.subtitle}
                </Text>
              </View>
            </View>
            <Text
              style={{
                fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                fontSize: 10.5,
                letterSpacing: 0.63,
                color: PAL.ink3,
                fontWeight: '600',
              }}
            >
              {briefMeta.stamp}
            </Text>
          </View>

          {items.map((it, i) => (
            <View
              key={it.id}
              style={{
                padding: 14,
                borderTopWidth: i > 0 ? 1 : 0,
                borderTopColor: PAL.lineSoft,
                opacity: loading && isDemo ? 0.6 : 1,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 6, height: 6, borderRadius: radius.pill, backgroundColor: briefToneColor(it.tone) }} />
                  <Text
                    style={{
                      fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                      fontSize: 9.5,
                      letterSpacing: 0.95,
                      textTransform: 'uppercase',
                      color: PAL.ink2,
                      fontWeight: '700',
                    }}
                  >
                    {it.tag}
                  </Text>
                </View>
                <Text
                  style={{
                    fontFamily: ONBOARDING_LITERALS.monoEyebrow,
                    fontSize: 9.5,
                    letterSpacing: 0.57,
                    color: PAL.ink3,
                    fontWeight: '500',
                  }}
                >
                  {it.time}
                </Text>
              </View>
              <Text
                style={{
                  fontSize: 14.5,
                  fontWeight: '600',
                  color: PAL.ink,
                  lineHeight: 19,
                  letterSpacing: -0.21,
                  marginTop: 4,
                }}
              >
                {it.title}
              </Text>
              <Text style={{ fontSize: 12.5, color: PAL.ink3, lineHeight: 18.125, marginTop: 4 }}>
                {it.detail}
              </Text>
            </View>
          ))}
        </GlassFrostedCard>
      </Animated.View>

      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE * 2).duration(STAGGER_DURATION)}
        style={{ marginTop: 14, paddingHorizontal: 2 }}
      >
        <Body style={{ fontSize: 13, color: PAL.ink3, lineHeight: 19.5 }}>
          {isDemo
            ? 'Det er en eksempel-brief. Den rigtige bygges når du forbinder din mail.'
            : loading
              ? 'Henter dine seneste mails…'
              : 'Et hurtigt kig på din indbakke. Den rigtige brief lander hver morgen.'}
        </Body>
      </Animated.View>

      <Animated.View
        entering={FadeInUp.delay(STAGGER_BASE * 3).duration(STAGGER_DURATION)}
        style={{ marginTop: 18, paddingBottom: 8 }}
      >
        <PrimaryButton label="Åbn Zolva →" onPress={next} />
      </Animated.View>
    </ScrollView>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Shell — progress bar, back button, screen switching
// ───────────────────────────────────────────────────────────────────────────

function ProgressBar({ index, total }: { index: number; total: number }) {
  const PAL = usePal();
  return (
    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center', height: 4 }}>
      {Array.from({ length: total }).map((_, i) => {
        const filled = i < index;
        const current = i === index;
        return (
          <View
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 3,
              backgroundColor: filled ? PAL.ink : current ? PAL.accent : ONBOARDING_LITERALS.inkAlpha10,
            }}
          />
        );
      })}
    </View>
  );
}

type Props = {
  onComplete: (state: OnboardingState) => void;
  // Opens the iCloud app-specific-password setup modal. Plumbed from App.tsx
  // because that's where IcloudSetupScreen lives - we render it as a sibling
  // modal on top of the onboarding flow, and the post-setup "credential
  // exists" signal comes back via useIcloudConnected.
  onOpenIcloudSetup?: () => void;
};

export function OnboardingFlowScreen({ onComplete, onOpenIcloudSetup }: Props) {
  const PAL = usePal();
  const { radius } = useTheme();
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<OnboardingState>(INITIAL_STATE);

  const next = () => {
    if (index < TOTAL_STEPS - 1) setIndex(index + 1);
    else onComplete(state);
  };
  const back = () => {
    if (index > 0) setIndex(index - 1);
  };

  const screens = [
    <ScreenWelcome         key="0" next={next} />,
    <ScreenDiagnose        key="1" state={state} setState={setState} next={next} />,
    <ScreenVision          key="2" state={state} setState={setState} next={next} />,
    <ScreenPersonalisation key="3" state={state} setState={setState} next={next} />,
    <ScreenExpectation     key="4" next={next} />,
    <ScreenTrust           key="5" state={state} setState={setState} next={next} onOpenIcloudSetup={onOpenIcloudSetup} />,
    <ScreenActivation      key="6" next={next} />,
  ];

  return (
    <View style={{ flex: 1, backgroundColor: PAL.paper }}>
      <GlassHaloLayer />

      {/* Top chrome — back button + progress + step counter */}
      <View
        style={{
          paddingTop: 54,
          paddingHorizontal: 18,
          paddingBottom: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          zIndex: 2,
        }}
      >
        <Pressable
          onPress={back}
          disabled={index === 0}
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: PAL.cardRim,
            backgroundColor: index === 0 ? 'transparent' : PAL.cardOff,
            opacity: index === 0 ? 0 : 1,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          accessibilityRole="button"
          accessibilityLabel="Tilbage"
        >
          <ChevLeft />
        </Pressable>

        <View style={{ flex: 1 }}>
          <ProgressBar index={index} total={TOTAL_STEPS} />
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 2 }}>
          <Text
            style={{
              fontFamily: ONBOARDING_LITERALS.monoEyebrow,
              fontSize: 10.5,
              letterSpacing: 1.05,
              color: PAL.ink,
              fontWeight: '600',
            }}
          >
            {String(index + 1).padStart(2, '0')}
          </Text>
          <Text
            style={{
              fontFamily: ONBOARDING_LITERALS.monoEyebrow,
              fontSize: 10.5,
              letterSpacing: 1.05,
              color: PAL.ink3,
              fontWeight: '600',
            }}
          >
            /{String(TOTAL_STEPS).padStart(2, '0')}
          </Text>
        </View>
      </View>

      {/* Screen body — keyed so each step gets a fresh entrance animation */}
      <View key={index} style={{ flex: 1, zIndex: 1 }}>
        {screens[index]}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    paddingTop: 8,
    paddingBottom: 24,
  },
  scroll: {
    flex: 1,
  },
});
