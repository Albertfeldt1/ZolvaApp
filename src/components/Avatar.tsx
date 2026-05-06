import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../design/useTheme';

type Tone = 'sage' | 'clay' | 'mist' | 'ink';

// Convert "#RRGGBB" → "rgba(r,g,b,a)". Accent tokens may already be rgba
// (twilight direction); leave those unchanged.
function withAlpha(c: string, alpha: number): string {
  if (c.startsWith('rgba') || c.startsWith('rgb(')) return c;
  if (c.startsWith('#') && c.length === 7) {
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return c;
}

export function Avatar({
  initials,
  tone = 'sage',
  size = 40,
}: {
  initials: string;
  tone?: Tone;
  size?: number;
}) {
  const { t } = useTheme();

  // Map each legacy tone to one accent in the active direction. The three
  // mail tones (sage/clay/mist) cycle per inbox row, so picking three
  // distinct accents keeps the visual variety the old palette provided
  // while the colors themselves now match the rest of the revamp.
  const accent =
    tone === 'sage'
      ? t.cal
      : tone === 'clay'
        ? t.today
        : tone === 'mist'
          ? t.mem
          : t.ink;
  const isInk = tone === 'ink';
  const bg = isInk ? t.ink : withAlpha(accent, 0.14);
  const fg = isInk ? t.paper : t.ink;
  const ring = isInk ? withAlpha(t.ink, 0.5) : withAlpha(accent, 0.28);

  const trimmed = initials.slice(0, 2) || '?';
  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          borderColor: ring,
        },
      ]}
    >
      <Text style={[styles.text, { color: fg, fontSize: Math.round(size * 0.36) }]}>
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
    letterSpacing: 0.2,
    fontFamily: 'SpaceGrotesk_600SemiBold',
  },
});
