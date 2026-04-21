import { X } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import type { Brief } from '../lib/briefs';

export function BriefBanner({ brief, onDismiss }: { brief: Brief; onDismiss: () => void }) {
  const weatherLine = brief.weather
    ? `${brief.weather.tempC.toFixed(0)}°C · ${brief.weather.conditionLabel}`
    : null;
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>
          {brief.kind === 'morning' ? 'Morgenbrief' : 'Aftenbrief'}
        </Text>
        <Pressable onPress={onDismiss} hitSlop={12} accessibilityLabel="Luk brief">
          <X size={16} color={colors.fg3} strokeWidth={1.75} />
        </Pressable>
      </View>
      <Text style={styles.headline}>{brief.headline}</Text>
      {brief.body.map((line, i) => (
        <Text key={i} style={styles.body}>
          {line}
        </Text>
      ))}
      {weatherLine && <Text style={styles.weather}>{weatherLine}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    margin: 16,
    padding: 16,
    borderRadius: 16,
    backgroundColor: colors.sageSoft,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  headline: {
    fontFamily: fonts.displayItalic,
    fontSize: 22,
    letterSpacing: -0.32,
    color: colors.ink,
    marginTop: 4,
  },
  body: {
    fontFamily: fonts.ui,
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.fg2,
  },
  weather: {
    marginTop: 8,
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.fg3,
  },
});
