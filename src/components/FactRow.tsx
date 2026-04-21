import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
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

export function FactRow({ fact, onDelete }: { fact: Fact; onDelete: () => void }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{CATEGORY_LABEL[fact.category]}</Text>
        <Text style={styles.text}>{fact.text}</Text>
      </View>
      <Pressable onPress={onDelete} hitSlop={12}>
        <Trash2 size={18} color={colors.fg3} strokeWidth={1.75} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  label: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.fg3 },
  text: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 21, color: colors.ink, marginTop: 2 },
});
