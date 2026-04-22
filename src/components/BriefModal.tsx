import { X } from 'lucide-react-native';
import React from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Brief } from '../lib/briefs';
import { colors, fonts } from '../theme';

type Props = {
  brief: Brief | null;
  visible: boolean;
  onClose: () => void;
};

export function BriefModal({ brief, visible, onClose }: Props) {
  const weatherLine = brief?.weather
    ? `${brief.weather.tempC.toFixed(0)}°C · ${brief.weather.conditionLabel}`
    : null;

  return (
    <Modal
      visible={visible && !!brief}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <View style={styles.topBar}>
          <View style={styles.eyebrowWrap}>
            <Text style={styles.eyebrow}>
              {brief?.kind === 'morning' ? 'Morgenbrief' : 'Aftenbrief'}
            </Text>
            {weatherLine && <Text style={styles.weather}>{weatherLine}</Text>}
          </View>
          <Pressable
            onPress={onClose}
            style={styles.closeBtn}
            hitSlop={12}
            accessibilityLabel="Luk brief"
          >
            <X size={18} color={colors.ink} strokeWidth={1.75} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {brief && (
            <>
              <Text style={styles.headline}>{brief.headline}</Text>
              <View style={styles.inkRule} />
              {brief.body.map((line, i) => (
                <Text key={i} style={styles.body}>
                  {line}
                </Text>
              ))}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  topBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 20 : 16,
    paddingHorizontal: 22,
    paddingBottom: 10,
  },
  eyebrowWrap: { gap: 4, flex: 1 },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  weather: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.fg3,
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: colors.mist,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: 22,
    paddingBottom: 40,
  },
  headline: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.6,
    color: colors.ink,
  },
  inkRule: {
    marginTop: 18,
    marginBottom: 18,
    height: 1,
    backgroundColor: colors.ink,
    opacity: 0.45,
  },
  body: {
    fontFamily: fonts.ui,
    fontSize: 16,
    lineHeight: 25,
    color: colors.fg2,
    marginBottom: 14,
  },
});
