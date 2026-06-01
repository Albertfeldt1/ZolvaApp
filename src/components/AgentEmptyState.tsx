import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../design/useTheme';
import { colors } from '../theme';

/**
 * "Zolva er klar" empty state.
 *
 * - Standalone (default): its own bone-white card matching the rest of the feed.
 * - `embedded`: renders flush/transparent so it can sit inside a parent card
 *   (used by the unified Today quiet-state card). No background, no margins,
 *   no radius — just vertical padding.
 */
export function AgentEmptyState({ embedded = false }: { embedded?: boolean }) {
  const { surface } = useTheme();
  return (
    <View
      style={[embedded ? styles.embedded : [styles.card, { backgroundColor: surface.bone }]]}
      accessibilityLabel="agent-empty-state"
    >
      <Text style={styles.title}>Zolva er klar</Text>
      <Text style={styles.body}>
        Når Zolva har handlet for dig eller har noget at foreslå, vises det her.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 12,
    gap: 4,
  },
  embedded: {
    paddingVertical: 4,
    gap: 4,
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 13, lineHeight: 18 },
});
