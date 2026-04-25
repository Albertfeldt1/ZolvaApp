import { X } from 'lucide-react-native';
import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useObservationHistory } from '../lib/hooks';
import type { StoredObservation } from '../lib/hooks';
import { colors, fonts } from '../theme';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function ObservationHistoryModal({ visible, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      {visible ? <ObservationHistoryContent onClose={onClose} /> : null}
    </Modal>
  );
}

function ObservationHistoryContent({ onClose }: { onClose: () => void }) {
  const { items, loading } = useObservationHistory();
  const today = new Date();

  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.card} onPress={() => {}}>
        <View style={styles.topBar}>
          <Text style={styles.title}>Bemærket</Text>
          <Pressable
            onPress={onClose}
            style={styles.closeBtn}
            hitSlop={12}
            accessibilityLabel="Luk"
          >
            <X size={18} color={colors.ink} strokeWidth={1.75} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {items.length === 0 && !loading && (
            <Text style={styles.empty}>Ingen tidligere observationer endnu.</Text>
          )}
          {items.map((o, i) => {
            const showDate = i === 0 || items[i - 1].sourceDate !== o.sourceDate;
            return (
              <View key={o.id}>
                {showDate && (
                  <Text style={[styles.dateEyebrow, i > 0 && styles.dateEyebrowSpaced]}>
                    {formatSourceDate(o.sourceDate, today)}
                  </Text>
                )}
                <View style={[styles.row, !showDate && styles.rowBorder]}>
                  <View style={[styles.moodDot, moodDotStyle(o)]} />
                  <Text style={styles.rowText}>{o.text}</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </Pressable>
    </Pressable>
  );
}

function moodDotStyle(o: StoredObservation) {
  if (o.mood === 'happy') return { backgroundColor: colors.sage };
  if (o.mood === 'thinking') return { backgroundColor: colors.clay };
  return { backgroundColor: colors.stone };
}

const DANISH_MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'maj', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
];

function formatSourceDate(sourceDate: string, today: Date): string {
  const [y, m, d] = sourceDate.split('-').map((s) => Number(s));
  if (!y || !m || !d) return sourceDate;
  const dateObj = new Date(y, m - 1, d);
  if (sameDay(dateObj, today)) return 'I dag';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(dateObj, yesterday)) return 'I går';
  const yearSuffix = dateObj.getFullYear() !== today.getFullYear() ? ` ${dateObj.getFullYear()}` : '';
  return `${dateObj.getDate()}. ${DANISH_MONTHS[dateObj.getMonth()]}${yearSuffix}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 60,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '100%',
    backgroundColor: colors.paper,
    borderRadius: 24,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 20,
    elevation: 12,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 20,
    paddingHorizontal: 22,
    paddingBottom: 14,
  },
  title: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
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
    paddingBottom: 24,
  },
  empty: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.fg3,
    paddingVertical: 24,
    textAlign: 'center',
  },
  dateEyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
    paddingTop: 4,
    paddingBottom: 8,
  },
  dateEyebrowSpaced: {
    paddingTop: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    marginTop: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  moodDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    marginTop: 7,
  },
  rowText: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink,
  },
});
