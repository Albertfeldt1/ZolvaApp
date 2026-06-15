import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, Trash2, X } from 'lucide-react-native';
import { colors, fonts } from '../theme';
import type { Fact, FactCategory } from '../lib/types';

const CATEGORY_LABEL: Record<FactCategory, string> = {
  relationship: 'Relation',
  role: 'Rolle',
  preference: 'Præference',
  project: 'Projekt',
  commitment: 'Løfte',
  other: 'Andet',
};

// A confirmed fact shows a delete affordance; a pending fact (onConfirm +
// onReject supplied) shows reject/confirm so the user can review what Zolva
// learned.
export function FactRow({
  fact,
  onDelete,
  onConfirm,
  onReject,
}: {
  fact: Fact;
  onDelete?: () => void;
  onConfirm?: () => void;
  onReject?: () => void;
}) {
  const review = !!onConfirm && !!onReject;
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{CATEGORY_LABEL[fact.category]}</Text>
        <Text style={styles.text}>{fact.text}</Text>
      </View>
      {review ? (
        <View style={styles.actions}>
          <Pressable onPress={onReject} hitSlop={10} accessibilityRole="button" accessibilityLabel="Afvis faktum">
            <X size={18} color={colors.fg3} strokeWidth={1.75} />
          </Pressable>
          <Pressable onPress={onConfirm} hitSlop={10} accessibilityRole="button" accessibilityLabel="Bekræft faktum">
            <Check size={18} color={colors.success} strokeWidth={2} />
          </Pressable>
        </View>
      ) : onDelete ? (
        <Pressable onPress={onDelete} hitSlop={12} accessibilityRole="button" accessibilityLabel="Slet faktum">
          <Trash2 size={18} color={colors.fg3} strokeWidth={1.75} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  label: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.fg3 },
  text: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 21, color: colors.ink, marginTop: 2 },
});
