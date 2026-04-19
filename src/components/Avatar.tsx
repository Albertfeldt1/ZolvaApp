import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

type Tone = 'sage' | 'clay' | 'mist' | 'ink';
const TONES: Record<Tone, { bg: string; fg: string }> = {
  sage: { bg: colors.sageSoft, fg: colors.sageDeep },
  clay: { bg: colors.claySoft, fg: colors.clayInk },
  mist: { bg: colors.mist, fg: colors.fg2 },
  ink: { bg: colors.ink, fg: colors.paper },
};

export function Avatar({ initials, tone = 'sage' }: { initials: string; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <View style={[styles.wrap, { backgroundColor: t.bg }]}>
      <Text style={[styles.text, { color: t.fg }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontFamily: fonts.uiSemi,
    fontSize: 13,
  },
});
