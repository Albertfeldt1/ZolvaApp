import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

type Tone = 'sage' | 'clay' | 'mist' | 'ink';

const TONES: Record<Tone, { bg: string; fg: string; ring: string }> = {
  sage: { bg: colors.sageSoft, fg: colors.sageDeep, ring: 'rgba(72,107,75,0.18)' },
  clay: { bg: colors.claySoft, fg: colors.clayInk, ring: 'rgba(168,116,82,0.20)' },
  mist: { bg: colors.mist, fg: colors.fg2, ring: 'rgba(60,72,86,0.16)' },
  ink: { bg: colors.ink, fg: colors.paper, ring: 'rgba(0,0,0,0.35)' },
};

export function Avatar({
  initials,
  tone = 'sage',
  size = 40,
}: {
  initials: string;
  tone?: Tone;
  size?: number;
}) {
  const t = TONES[tone];
  const trimmed = initials.slice(0, 2) || '?';
  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: t.bg,
          borderColor: t.ring,
        },
      ]}
    >
      <Text style={[styles.text, { color: t.fg, fontSize: Math.round(size * 0.36) }]}>
        {trimmed}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: {
    fontFamily: fonts.uiSemi,
    letterSpacing: 0.2,
  },
});
