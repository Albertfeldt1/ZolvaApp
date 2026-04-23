import { Easing } from 'react-native';

export const colors = {
  paper: '#F6F1E8',
  paperDeep: '#EFE8DA',
  mist: '#E8E1D3',
  ink: '#1A1E1C',
  inkSoft: '#3A413D',
  stone: '#8C8578',
  stoneSoft: '#B8B1A3',
  line: 'rgba(26, 30, 28, 0.10)',
  lineSoft: 'rgba(26, 30, 28, 0.06)',

  sage: '#5C7355',
  sageDeep: '#3D4E38',
  sageSoft: '#D4DCC8',

  clay: '#C17A5B',
  claySoft: '#F2E2D8',
  clayInk: '#8A4A2E',

  success: '#4A7C4E',
  warning: '#C9A23D',
  warningSoft: '#F6EBC9',
  warningInk: '#8A6F1A',
  danger: '#B34B3A',

  fg1: '#1A1E1C',
  fg2: '#3A413D',
  fg3: '#8C8578',
  fg4: '#B8B1A3',

  paperOn90: 'rgba(246,241,232,0.90)',
  paperOn75: 'rgba(246,241,232,0.75)',
  paperOn55: 'rgba(246,241,232,0.55)',
  paperOn50: 'rgba(246,241,232,0.50)',
  paperOn25: 'rgba(246,241,232,0.25)',
  paperOn20: 'rgba(246,241,232,0.20)',
  paperOn95: 'rgba(246,241,232,0.95)',
  sageDim: '#C3D4B8',

  // Launch-transition color. Must match app.json splash.backgroundColor
  // and IntroVideo root so the native splash → intro → app handoff has
  // no visible color jitter.
  intro: '#2596be',
};

export const fonts = {
  display: 'Fraunces_500Medium',
  displayItalic: 'PlayfairDisplay_400Regular_Italic',
  displayItalicMedium: 'PlayfairDisplay_500Medium_Italic',
  ui: 'Inter_500Medium',
  uiSemi: 'Inter_600SemiBold',
  uiRegular: 'Inter_400Regular',
  mono: 'JetBrainsMono_400Regular',
  monoSemi: 'JetBrainsMono_600SemiBold',
};

export const radii = {
  r1: 4,
  r2: 6,
  r3: 10,
  r4: 14,
  r5: 20,
  r6: 28,
  pill: 999,
};

export const spacing = {
  s1: 2,
  s2: 4,
  s3: 8,
  s4: 12,
  s5: 16,
  s6: 20,
  s7: 24,
  s8: 32,
  s9: 40,
  s10: 56,
};

export const motion = {
  easeOut: Easing.bezier(0.22, 1, 0.36, 1),
  easeInOut: Easing.bezier(0.65, 0, 0.35, 1),
  durMicro: 120,
  durBase: 220,
  durSlow: 400,
};

export const shadows = {
  fab: {
    shadowColor: '#1A1E1C',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 8,
  },
  tabBar: {
    shadowColor: '#1A1E1C',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.06,
    shadowRadius: 24,
    elevation: 4,
  },
};
