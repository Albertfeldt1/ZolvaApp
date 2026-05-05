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

export const fontFamilies = {
  display: 'SpaceGrotesk_500Medium',
  displayBold: 'SpaceGrotesk_600SemiBold',
  ui: 'Inter_500Medium',
  uiBold: 'Inter_600SemiBold',
  uiRegular: 'Inter_400Regular',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_600SemiBold',
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

export const spacing = { xs: 4, sm: 8, md: 12, lg: 18, xl: 24, xxl: 32, screenPad: 18 } as const;
export const radius  = { sharp: 6, soft: 18, pill: 9999, card: 24, cardSm: 14 } as const;

export const stoneTokens = {
  body: '#6B8770',
  edge: '#3F5446',
  glow: '#8AA38C',
  rim: '#7E9A82',
  face: '#1a221d',
  shadowCast: 'rgba(60,90,70,0.35)',
} as const;
