import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import { Stone, StoneMood } from './Stone';

type Props = {
  mood?: StoneMood;
  title: string;
  body?: string;
  ctaLabel?: string;
  onCta?: () => void;
  dark?: boolean;
  icon?: boolean;
};

export function EmptyState({ mood = 'calm', title, body, ctaLabel, onCta, dark, icon = true }: Props) {
  const titleStyle = dark ? styles.titleDark : styles.titleLight;
  const bodyStyle = dark ? styles.bodyDark : styles.bodyLight;
  const ctaStyle = dark ? styles.ctaDark : styles.ctaLight;
  const ctaTextStyle = dark ? styles.ctaTextDark : styles.ctaTextLight;
  return (
    <View style={styles.wrap}>
      {icon && <Stone mood={mood} size={42} />}
      <Text style={[styles.title, titleStyle]}>{title}</Text>
      {body && <Text style={[styles.body, bodyStyle]}>{body}</Text>}
      {ctaLabel && onCta && (
        <Pressable onPress={onCta} style={[styles.cta, ctaStyle]}>
          <Text style={[styles.ctaText, ctaTextStyle]}>{ctaLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 28,
    paddingHorizontal: 16,
    gap: 10,
  },
  title: {
    marginTop: 4,
    fontFamily: fonts.displayItalic,
    fontSize: 20,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  titleLight: { color: colors.ink },
  titleDark: { color: colors.paper },
  body: {
    fontFamily: fonts.ui,
    fontSize: 13.5,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 280,
  },
  bodyLight: { color: colors.fg3 },
  bodyDark: { color: colors.paperOn75 },
  cta: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
  },
  ctaLight: { backgroundColor: colors.ink },
  ctaDark: { backgroundColor: colors.sage },
  ctaText: {
    fontFamily: fonts.uiSemi,
    fontSize: 13,
  },
  ctaTextLight: { color: colors.paper },
  ctaTextDark: { color: colors.paper },
});
