import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

export function AgentEmptyState() {
  return (
    <View style={styles.card} accessibilityLabel="agent-empty-state">
      <Text style={styles.title}>Zolva er klar</Text>
      <Text style={styles.body}>
        Når Zolva har handlet for dig eller har noget at foreslå, vises det her.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paperDeep,
    borderRadius: 14,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 12,
    gap: 4,
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 13, lineHeight: 18 },
});
