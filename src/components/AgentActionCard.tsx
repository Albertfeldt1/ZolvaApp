import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { revertAgentAction, type AgentActionRow } from '../lib/agent-feed';
import { colors } from '../theme';

const TITLES: Record<AgentActionRow['action_type'], string> = {
  'mail.archive': 'Arkiveret',
  'mail.label': 'Mærket',
  'mail.flag_important': 'Markeret som vigtig',
  'mail.summarize': 'Opsummeret',
};

function detailFor(row: AgentActionRow): string {
  switch (row.action_type) {
    case 'mail.summarize': {
      const s = row.payload.summary;
      return typeof s === 'string' ? s : '';
    }
    case 'mail.label': {
      const l = row.payload.label;
      const op = row.payload.op;
      return typeof l === 'string' ? `${op === 'remove' ? 'Fjernet' : 'Tilføjet'}: ${l}` : '';
    }
    default:
      return '';
  }
}

export function AgentActionCard({ row }: { row: AgentActionRow }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isReverted = !!row.reversed_at;

  async function onUndo() {
    setPending(true);
    setError(null);
    const r = await revertAgentAction(row.id);
    setPending(false);
    if (!r.ok) setError(r.error ?? 'fejl');
  }

  return (
    <View style={styles.card} accessibilityLabel={`agent-action-${row.action_type}`}>
      <View style={styles.row}>
        <Text style={styles.badge}>✓ Udført</Text>
        <Text style={styles.title}>{TITLES[row.action_type]}</Text>
      </View>
      {detailFor(row) ? <Text style={styles.detail}>{detailFor(row)}</Text> : null}
      <View style={styles.actions}>
        {row.reversible && !isReverted ? (
          <Pressable onPress={onUndo} disabled={pending} accessibilityLabel="undo">
            {pending ? <ActivityIndicator size="small" /> : <Text style={styles.undo}>Fortryd</Text>}
          </Pressable>
        ) : isReverted ? (
          <Text style={styles.muted}>Fortrudt</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paperDeep,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 8,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { color: colors.fg3, fontSize: 12, fontWeight: '600' },
  title: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  detail: { color: colors.fg3, fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  undo: { color: colors.ink, fontSize: 14, fontWeight: '500', textDecorationLine: 'underline' },
  muted: { color: colors.fg3, fontSize: 13 },
  error: { color: '#A24', fontSize: 12 },
});
