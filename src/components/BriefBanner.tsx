import { ChevronRight, X } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import type { Brief } from '../lib/briefs';

type Props = {
  brief: Brief;
  onOpen: () => void;
  onDismiss: () => void;
};

export function BriefBanner({ brief, onOpen, onDismiss }: Props) {
  const weatherLine = brief.weather
    ? `${brief.weather.tempC.toFixed(0)}°C · ${brief.weather.conditionLabel}`
    : null;
  return (
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel="Åbn brief"
    >
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>
          {brief.kind === 'morning' ? 'Morgenbrief' : 'Aftenbrief'}
        </Text>
        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            onDismiss();
          }}
          hitSlop={12}
          accessibilityLabel="Luk brief"
        >
          <X size={16} color={colors.fg3} strokeWidth={1.75} />
        </Pressable>
      </View>
      <Text style={styles.headline}>{brief.headline}</Text>
      {brief.body.slice(0, 1).map((line, i) => (
        <Text key={i} style={styles.body} numberOfLines={2}>
          {line}
        </Text>
      ))}
      <View style={styles.footerRow}>
        {weatherLine && <Text style={styles.weather}>{weatherLine}</Text>}
        <View style={styles.cta}>
          <Text style={styles.ctaText}>Læs mere</Text>
          <ChevronRight size={14} color={colors.sageDeep} strokeWidth={1.75} />
        </View>
      </View>
    </Pressable>
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
  cardPressed: { opacity: 0.82 },
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
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.fg3,
  },
  footerRow: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  ctaText: {
    fontFamily: fonts.monoSemi,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
});
