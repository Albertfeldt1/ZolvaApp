// Design tokens for the Glass & Air revamp.
// Source: handoff/tokens.json. Direction G is the active default.

export type DirectionId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export type DirectionTokens = {
  id: DirectionId;
  name: string;
  paper: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  line: string;
  today: string;
  inbox: string;
  cal: string;
  mem: string;
  radius: number;
  radiusSm: number;
  mode: 'light' | 'dark';
  displayFontOverride?: string;
};

const inkScale = (ink: string) => ({
  ink,
  ink2: '#3A3D43',
  ink3: '#7A7D84',
  ink4: '#B5B7BB',
  line: 'rgba(15,16,20,0.08)',
});

export const directions: Record<DirectionId, DirectionTokens> = {
  A: { id: 'A', name: 'Vibrant Fills',   paper: '#FFFFFF', today: '#FF6B35', inbox: '#2D6CDF', cal: '#0E9F6E', mem: '#7C3AED', radius: 18, radiusSm: 14, mode: 'light', ...inkScale('#0B0B0C') },
  B: { id: 'B', name: 'Soft Saturation', paper: '#FFFFFF', today: '#FB923C', inbox: '#3B82F6', cal: '#10B981', mem: '#A855F7', radius: 14, radiusSm: 12, mode: 'light', ...inkScale('#0B0B0C') },
  C: { id: 'C', name: 'Bold Contrast',   paper: '#FFFFFF', today: '#F43F5E', inbox: '#0EA5E9', cal: '#84CC16', mem: '#9333EA', radius: 22, radiusSm: 16, mode: 'light', ...inkScale('#0B0B0C') },
  D: { id: 'D', name: 'Neutral + Pop',   paper: '#FFFFFF', today: '#FFD60A', inbox: '#1F4FFF', cal: '#00B894', mem: '#FF4F8B', radius: 12, radiusSm: 10, mode: 'light', ...inkScale('#0B0B0C') },
  E: { id: 'E', name: 'Twilight',        paper: '#0B0D11', today: '#FF7A66', inbox: '#7AB8FF', cal: '#A8E063', mem: '#C39BFF', radius: 16, radiusSm: 12, mode: 'dark',  ink: '#F5F4F0', ink2: 'rgba(245,244,240,0.8)', ink3: 'rgba(245,244,240,0.6)', ink4: 'rgba(245,244,240,0.35)', line: 'rgba(255,255,255,0.10)' },
  F: { id: 'F', name: 'Editorial Mono',  paper: '#FAFAF7', today: '#E64A2E', inbox: '#111111', cal: '#111111', mem: '#111111', radius: 4,  radiusSm: 4,  mode: 'light', ...inkScale('#111111'), displayFontOverride: 'PlayfairDisplay_500Medium_Italic' },
  G: { id: 'G', name: 'Glass & Air',     paper: '#FBFBFA', today: '#FF7A4D', inbox: '#FF7A4D', cal: '#FF9D6E', mem: '#B07AE0', radius: 24, radiusSm: 18, mode: 'light', ...inkScale('#0F1014') },
  H: { id: 'H', name: 'Card Stack',      paper: '#F2F1ED', today: '#D45A2E', inbox: '#3F6FB5', cal: '#5B8765', mem: '#8B6BBA', radius: 16, radiusSm: 12, mode: 'light', ...inkScale('#1A1A1C') },
};

export const DEFAULT_DIRECTION: DirectionId = 'G';

// One font family everywhere - SpaceGrotesk handles display, UI, and the
// "mono" eyebrows. Aliases stay so existing call sites don't need to know
// which variant they're getting; only the underlying weight differs.
export const fontFamilies = {
  display: 'SpaceGrotesk_500Medium',
  displayBold: 'SpaceGrotesk_700Bold',
  ui: 'SpaceGrotesk_500Medium',
  uiBold: 'SpaceGrotesk_600SemiBold',
  uiRegular: 'SpaceGrotesk_500Medium',
  mono: 'SpaceGrotesk_500Medium',
  monoBold: 'SpaceGrotesk_600SemiBold',
} as const;

export const typeScale = {
  displayXL: { fontSize: 44, lineHeight: 46, letterSpacing: -2,   fontFamily: fontFamilies.display     },
  displayL:  { fontSize: 34, lineHeight: 36, letterSpacing: -1.4, fontFamily: fontFamilies.displayBold },
  displayM:  { fontSize: 30, lineHeight: 34, letterSpacing: -1.2, fontFamily: fontFamilies.displayBold },
  displayS:  { fontSize: 24, lineHeight: 28, letterSpacing: -0.8, fontFamily: fontFamilies.displayBold },
  title:     { fontSize: 18, lineHeight: 22, letterSpacing: -0.3, fontFamily: fontFamilies.uiBold      },
  body:      { fontSize: 14, lineHeight: 20, letterSpacing: 0,    fontFamily: fontFamilies.ui          },
  bodySm:    { fontSize: 13, lineHeight: 18, letterSpacing: 0,    fontFamily: fontFamilies.ui          },
  caption:   { fontSize: 11.5, lineHeight: 16, letterSpacing: 0,  fontFamily: fontFamilies.ui          },
  eyebrow:   { fontSize: 10.5, lineHeight: 14, letterSpacing: 1.2, fontFamily: fontFamilies.mono, textTransform: 'uppercase' as const },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  xxl: 32,
  // Semantic
  screenPad: 18,
  cardPad: 14,
  heroPad: 22,
  statusBarFallback: 56,
  tabBarLift: 18,
  tabBarSideMargin: 48,
  fabSideMargin: 48,
} as const;

export const radius = { sharp: 6, soft: 18, pill: 9999, card: 24, cardSm: 14 } as const;

export const stoneTokens = {
  body: '#6B8770',
  edge: '#3F5446',
  glow: '#8AA38C',
  rim: '#7E9A82',
  face: '#1a221d',
  shadowCast: 'rgba(60,90,70,0.35)',
} as const;

// Hero stat card - pulled out so consumers don't carry literals.
// `bigLineHeight` must be >= `bigSize` or RN clips the top of large
// display digits (notably "0" / "8" rendered in Space Grotesk 64pt).
export const heroStat = {
  bigSize: 64,
  bigLineHeight: 72,
  bigLetterSpacing: -3,
  midSize: 28,
  midLetterSpacing: -1,
  ribbonHeight: 8,
} as const;

// BlurView intensities - direction G is light, intensities map well across iOS;
// Android uses lower values everywhere because the native blur is weaker.
export const blur = {
  card: 45,
  hero: 50,
  glassStrong: 70,
  haloField: 80,
  tabBarIos: 70,
  tabBarAndroid: 60,
  pill: 14,
} as const;

// Reusable shadow presets. RN consumes these via spread on a View's style.
export type ShadowPreset = {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
};

export const shadows: Record<'softCard' | 'elevated' | 'fab' | 'tabBar' | 'stoneCast', ShadowPreset> = {
  softCard:  { shadowColor: '#0F1014', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.06, shadowRadius: 16, elevation: 2 },
  elevated:  { shadowColor: '#0F1014', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.10, shadowRadius: 24, elevation: 6 },
  fab:       { shadowColor: '#000000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 24, elevation: 8 },
  tabBar:    { shadowColor: '#000000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.10, shadowRadius: 24, elevation: 6 },
  stoneCast: { shadowColor: '#5C7355', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 12, elevation: 6 },
};

// Surface overlays - direction-aware. Glass overlays sit above the BlurView
// to give the frosted look its tint and saturation; the dark variants flip
// the ratios for Twilight (E).
export type SurfaceTokens = {
  glass: string;
  glassStrong: string;
  glassWeak: string;
  glassRim: string;
  glassAndroidFallback: string;
  glassDark: string;
  glassDarkText: string;
  glassDarkTextSoft: string;
  /** Near-opaque card surface - for "bone white" hero/section backdrops
   *  where translucency would let halos bleed through too aggressively. */
  bone: string;
  scrim: string;
  fab: string;
  fabText: string;
  iconButton: string;
  tabBar: string;
  tabActive: string;
  warningTint: string;
  ribbonTrack: string;
  /** Semantic state - connected / OK / done. Direction G has no green
   *  signal, so success is encoded here as a universally-understood
   *  state cue instead of being derived from a direction signal hue. */
  successText: string;
  successTint: string;
};

const SURFACES_LIGHT: SurfaceTokens = {
  glass:                'rgba(255,255,255,0.65)',
  glassStrong:          'rgba(255,255,255,0.55)',
  glassWeak:            'rgba(255,255,255,0.7)',
  glassRim:             'rgba(255,255,255,0.8)',
  glassAndroidFallback: 'rgba(255,255,255,0.85)',
  glassDark:            'rgba(15,16,20,0.78)',
  glassDarkText:        '#F5F4F0',
  glassDarkTextSoft:    'rgba(245,244,240,0.7)',
  bone:                 'rgba(252,251,248,0.95)',
  scrim:                'rgba(15,16,20,0.05)',
  fab:                  'rgba(21,23,26,0.78)',
  fabText:              '#FFFFFF',
  iconButton:           'rgba(21,23,26,0.05)',
  tabBar:               'rgba(255,255,255,0.55)',
  tabActive:            'rgba(255,255,255,0.9)',
  warningTint:          'rgba(255,193,127,0.55)',
  ribbonTrack:          'rgba(15,16,20,0.05)',
  successText:          '#15803D',
  successTint:          'rgba(34,197,94,0.16)',
};

const SURFACES_DARK: SurfaceTokens = {
  glass:                'rgba(27,32,48,0.65)',
  glassStrong:          'rgba(27,32,48,0.55)',
  glassWeak:            'rgba(27,32,48,0.7)',
  glassRim:             'rgba(255,255,255,0.10)',
  glassAndroidFallback: 'rgba(27,32,48,0.85)',
  glassDark:            'rgba(0,0,0,0.55)',
  glassDarkText:        '#F5F4F0',
  glassDarkTextSoft:    'rgba(245,244,240,0.7)',
  bone:                 'rgba(20,22,28,0.92)',
  scrim:                'rgba(255,255,255,0.05)',
  fab:                  'rgba(242,239,232,0.92)',
  fabText:              '#0E1117',
  iconButton:           'rgba(255,255,255,0.10)',
  tabBar:               'rgba(27,32,48,0.65)',
  tabActive:            'rgba(255,255,255,0.12)',
  warningTint:          'rgba(255,193,127,0.45)',
  ribbonTrack:          'rgba(255,255,255,0.08)',
  successText:          '#86EFAC',
  successTint:          'rgba(74,222,128,0.22)',
};

export function getSurfaces(t: DirectionTokens): SurfaceTokens {
  return t.mode === 'dark' ? SURFACES_DARK : SURFACES_LIGHT;
}
