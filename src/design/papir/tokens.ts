// Papir design tokens — the single source of truth for the new look.
//
// Ported 1:1 from the "papir_app.html" prototype + handover spec. This is a
// paper/editorial aesthetic: warm paper, ink greys, a terracotta accent, with
// Fraunces (serif) carrying display/headings and Inter carrying all UI text.
//
// New screens are built against THESE tokens; the old "Glass & Air" theme
// (src/design/theme.ts) is left untouched so the app keeps running while we
// migrate screen-by-screen. Never reference raw hex in components — use these.
import type { TextStyle, ViewStyle } from 'react-native';
import { Easing } from 'react-native-reanimated';

// ─── Colors (light — the prototype's actual values) ──────────────────────────
export const papirColor = {
  paper: '#FBFAF6', // app background
  paper2: '#F5F2EA', // secondary surface, segment track, icon boxes
  card: '#FFFFFF', // cards, rows, inputs
  ink: '#1B1A17', // primary text + primary button
  ink2: '#5C584F', // secondary text
  ink3: '#969080', // tertiary text, eyebrow, meta
  ink4: '#B8B2A2', // disabled, inactive nav, hairline text
  line: '#E8E3D8', // borders
  lineSoft: '#F0ECE2', // faint dividers (timeline/lists)
  red: '#C2452F', // accent (active, urgent-now, CTA)
  redSoft: '#F7E9E4', // accent surface behind red icons
  green: '#5E7A52', // success, toggle-on, "online"
  onInk: '#FBFAF6', // text on a dark surface

  // Category accent duos (deep text on soft surface) — from the 2026-07-06
  // Claude-design exploration Oscar approved: event-ribbon rotation, content
  // tags (TALENOTE/NOTE) and the "Svar klar" badge. Always use a duo as a
  // PAIR; deep-on-soft is what keeps them readable on paper.
  greenSoft: '#E9EFE4', // surface under green (events, "Svar klar")
  slate: '#5D6B7A', // calm blue-grey (notes, drafts, second event color)
  slateSoft: '#E7EAEE',
  rust: '#B0603F', // warm third accent — softer than red, never urgent
  rustSoft: '#F4E5DD',
} as const;

// Dark surfaces used WITHIN light mode (brief-card / upsell gradient) — these
// are not a full dark theme, just dark cards on the light background.
export const papirDarkSurface = {
  gradientFrom: '#2A2419',
  gradientTo: '#454035', // 135deg
  text: '#FBFAF6',
  muted: '#C9C4B6', // also '#CFC9BB' in places
} as const;

// Dark MODE is deferred to v2. The spec's dark palette is an unverified guess,
// so it is intentionally NOT included here yet. See project_reskin_direction.

// ─── Fonts ────────────────────────────────────────────────────────────────
// Weight is encoded in the family name (RN custom-font convention), so type
// roles set fontFamily and omit fontWeight. These families must be loaded via
// @expo-google-fonts/fraunces + @expo-google-fonts/inter (see App.tsx fonts).
export const papirFont = {
  display: 'Fraunces_500Medium',
  displayLight: 'Fraunces_400Regular',
  displaySemi: 'Fraunces_600SemiBold',
  serifBody: 'Fraunces_400Regular',
  ui: 'Inter_400Regular',
  uiMedium: 'Inter_500Medium',
  uiSemi: 'Inter_600SemiBold',
  uiBold: 'Inter_700Bold',
} as const;

// ─── Typography roles (from the handover type scale) ─────────────────────────
export type PapirTypeRole =
  | 'displayL'
  | 'displayM'
  | 'displayS'
  | 'titleSerif'
  | 'statNumber'
  | 'price'
  | 'heading'
  | 'name'
  | 'bodySerif'
  | 'body'
  | 'bodyStrong'
  | 'button'
  | 'chip'
  | 'small'
  | 'caption'
  | 'eyebrow'
  | 'navLabel';

export const papirType: Record<PapirTypeRole, TextStyle> = {
  displayL: { fontFamily: papirFont.display, fontSize: 34, lineHeight: 38, letterSpacing: -0.4 },
  displayM: { fontFamily: papirFont.display, fontSize: 30, lineHeight: 34, letterSpacing: -0.4 },
  displayS: { fontFamily: papirFont.display, fontSize: 27, lineHeight: 32, letterSpacing: -0.3 },
  titleSerif: { fontFamily: papirFont.display, fontSize: 19, lineHeight: 24, letterSpacing: -0.2 },
  statNumber: { fontFamily: papirFont.display, fontSize: 26, lineHeight: 28 },
  price: { fontFamily: papirFont.display, fontSize: 44, lineHeight: 46 },
  heading: { fontFamily: papirFont.uiSemi, fontSize: 18, lineHeight: 22, letterSpacing: -0.2 },
  name: { fontFamily: papirFont.uiSemi, fontSize: 21, lineHeight: 26, letterSpacing: -0.2 },
  bodySerif: { fontFamily: papirFont.serifBody, fontSize: 18, lineHeight: 29 },
  body: { fontFamily: papirFont.ui, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: papirFont.uiSemi, fontSize: 15, lineHeight: 22, letterSpacing: -0.1 },
  button: { fontFamily: papirFont.uiSemi, fontSize: 15, lineHeight: 18 },
  chip: { fontFamily: papirFont.uiMedium, fontSize: 13, lineHeight: 16 },
  small: { fontFamily: papirFont.uiMedium, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: papirFont.uiMedium, fontSize: 12, lineHeight: 16 },
  eyebrow: {
    fontFamily: papirFont.uiSemi,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  navLabel: { fontFamily: papirFont.uiMedium, fontSize: 10, lineHeight: 12, letterSpacing: 0.2 },
};

// Tabular figures for clocks/timers/durations: spread alongside a type role.
export const papirTabular: TextStyle = { fontVariant: ['tabular-nums'] };

// ─── Spacing (4-based) ───────────────────────────────────────────────────────
export const papirSpace = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  screen: 22, // screen side padding
  xl: 24,
  xxl: 28,
  xxxl: 36,
} as const;

// ─── Radii ───────────────────────────────────────────────────────────────────
export const papirRadius = {
  sm: 11, // small boxes, list icon boxes
  md: 14, // segment button, action card, search field
  lg: 16, // buttons
  xl: 18, // set-box, quick button
  xxl: 20, // standard card, note, menu
  card: 22, // brief-card, upsell
  avatar: 26,
  pill: 999,
} as const;

// ─── Shadows (low, warm). RN allows one shadow per view; shadowColor = ink. ───
export const papirShadow = {
  sm: {
    shadowColor: '#1B1A17',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  base: {
    shadowColor: '#1B1A17',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.07,
    shadowRadius: 30,
    elevation: 4,
  },
  red: {
    // record FAB
    shadowColor: '#C2452F',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 8,
  },
  ink: {
    // record stop button
    shadowColor: '#1B1A17',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.28,
    shadowRadius: 30,
    elevation: 10,
  },
} as const satisfies Record<string, ViewStyle>;

// ─── Motion (complements the spring presets in src/design/motion) ─────────────
// Standard easing for everything except blink/loop animations.
export const papirEasing = Easing.bezier(0.4, 0, 0.1, 1);

export const papirDuration = {
  press: 160,
  check: 220,
  toggle: 250,
  segment: 250,
  tabFade: 500,
  pushIn: 420,
  overlay: 460,
  navHide: 400,
  waveTick: 130, // live-waveform update interval
} as const;
