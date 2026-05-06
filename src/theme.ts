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
  // and IntroVideo root so the native splash → intro handoff has no
  // visible border around the video. Nudged 1 point darker than the
  // video's dominant interior pixels (#ECE4D8) because iOS native
  // splash and AVFoundation video rendering land 1-2 points apart in
  // practice — this biases the splash darker so the letterbox seam
  // visually closes.
  intro: '#EBE3D7',
};

// One font family everywhere — SpaceGrotesk. Aliases preserved so legacy
// call sites still resolve, but every variant maps to a SpaceGrotesk weight.
// Italic aliases lose their stylistic italic shape (SpaceGrotesk has no
// italic cut loaded); pair them with `fontStyle: 'italic'` at the call site
// if a slanted look is still wanted.
export const fonts = {
  display: 'SpaceGrotesk_500Medium',
  displayItalic: 'SpaceGrotesk_500Medium',
  displayItalicMedium: 'SpaceGrotesk_600SemiBold',
  ui: 'SpaceGrotesk_500Medium',
  uiSemi: 'SpaceGrotesk_600SemiBold',
  uiRegular: 'SpaceGrotesk_500Medium',
  mono: 'SpaceGrotesk_500Medium',
  monoSemi: 'SpaceGrotesk_600SemiBold',
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
