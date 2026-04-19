import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

type Tone = 'neutral' | 'sage' | 'warning' | 'clay';
const TONES: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: colors.mist, fg: colors.fg2 },
  sage: { bg: colors.sageSoft, fg: colors.sageDeep },
  warning: { bg: colors.warningSoft, fg: colors.warningInk },
  clay: { bg: colors.claySoft, fg: colors.clayInk },
};

export function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <View style={[styles.wrap, { backgroundColor: t.bg }]}>
      <Text style={[styles.text, { color: t.fg }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  text: {
    fontFamily: fonts.uiSemi,
    fontSize: 11.5,
  },
});
