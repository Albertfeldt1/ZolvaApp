import { Moon, Sun, X } from 'lucide-react-native';
import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Brief } from '../lib/briefs';
import { useBriefHistory } from '../lib/briefs';
import { colors, fonts } from '../theme';

type Props = {
  kind: 'morning' | 'evening' | null;
  onClose: () => void;
  onSelect: (brief: Brief) => void;
};

export function BriefHistoryModal({ kind, onClose, onSelect }: Props) {
  return (
    <Modal
      visible={kind !== null}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      {kind !== null ? (
        <BriefHistoryContent kind={kind} onClose={onClose} onSelect={onSelect} />
      ) : null}
    </Modal>
  );
}

function BriefHistoryContent({
  kind,
  onClose,
  onSelect,
}: {
  kind: 'morning' | 'evening';
  onClose: () => void;
  onSelect: (brief: Brief) => void;
}) {
  const { items, loading } = useBriefHistory(kind);
  const Icon = kind === 'evening' ? Moon : Sun;
  const title = kind === 'evening' ? 'Aftenbriefs' : 'Morgenbriefs';
  const today = new Date();
  const emptyLabel = kind === 'evening' ? 'aftenbriefs' : 'morgenbriefs';

  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.card} onPress={() => {}}>
        <View style={styles.topBar}>
          <View style={styles.titleRow}>
            <Icon size={18} color={colors.sageDeep} strokeWidth={1.75} />
            <Text style={styles.title}>{title}</Text>
          </View>
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
            <Text style={styles.empty}>Ingen {emptyLabel} endnu.</Text>
          )}
          {items.map((b, i) => (
            <Pressable
              key={b.id}
              onPress={() => onSelect(b)}
              style={[styles.row, i > 0 && styles.rowBorder]}
              android_ripple={{ color: colors.mist }}
            >
              <Text style={styles.rowDate}>{formatBriefDate(b.generatedAt, today)}</Text>
              <Text style={styles.rowHeadline} numberOfLines={2}>
                {b.headline}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </Pressable>
    </Pressable>
  );
}

const DANISH_MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'maj', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
];

function formatBriefDate(d: Date, today: Date): string {
  if (sameDay(d, today)) return 'I dag';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return 'I går';
  const day = d.getDate();
  const month = DANISH_MONTHS[d.getMonth()];
  const yearSuffix = d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${day}. ${month}${yearSuffix}`;
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
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
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
  row: { paddingVertical: 14 },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowDate: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
    marginBottom: 4,
  },
  rowHeadline: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.4,
    color: colors.ink,
  },
});
