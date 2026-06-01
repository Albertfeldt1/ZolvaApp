import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { revertAgentAction, type AgentActionRow } from '../lib/agent-feed';
import { useTheme } from '../design/useTheme';
import { colors } from '../theme';

export const TITLES: Record<string, string> = {
  'mail.archive': 'Arkiveret',
  'mail.label': 'Mærket',
  'mail.flag_important': 'Markeret som vigtig',
  'mail.summarize': 'Opsummeret',
  'mail.draft_reply': 'Udkast til svar',
  'mail.send_reply': 'Svar sendt',
  'mail.send_new': 'Mail sendt',
  'cal.create_event': 'Begivenhed oprettet',
  'cal.update_event': 'Begivenhed opdateret',
  'nudge.push': 'Påmindelse sendt',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function detailFor(row: AgentActionRow): string {
  switch (row.action_type) {
    case 'mail.summarize':
      return str(row.payload.summary);
    case 'mail.label': {
      const l = row.payload.label;
      const op = row.payload.op;
      return typeof l === 'string' ? `${op === 'remove' ? 'Fjernet' : 'Tilføjet'}: ${l}` : '';
    }
    case 'mail.draft_reply':
    case 'mail.send_reply':
    case 'mail.send_new': {
      // Prefer the subject/preview line; fall back to the recipient.
      const subject = str(row.payload.subject) || str(row.payload.preview_text);
      const to = str(row.payload.to);
      if (subject && to) return `${subject} · til ${to}`;
      return subject || (to ? `Til ${to}` : '');
    }
    case 'cal.create_event': {
      const title = str(row.payload.title);
      const when = str(row.payload.start_iso);
      if (title && when) return `${title} · ${when}`;
      return title || when;
    }
    case 'cal.update_event': {
      const parts: string[] = [];
      if (str(row.payload.start_iso)) parts.push(`ny tid ${str(row.payload.start_iso)}`);
      if (str(row.payload.title)) parts.push(`ny titel ${str(row.payload.title)}`);
      if (str(row.payload.location)) parts.push(`nyt sted ${str(row.payload.location)}`);
      return parts.join(' · ');
    }
    default:
      return '';
  }
}

export function AgentActionCard({
  row,
  embedded = false,
  onOpenDetail,
}: {
  row: AgentActionRow;
  embedded?: boolean;
  onOpenDetail?: (row: AgentActionRow) => void;
}) {
  const { surface, shadows, t } = useTheme();
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
    <View
      style={[
        styles.card,
        embedded
          ? { marginHorizontal: 0, borderWidth: 0, borderTopWidth: 1, borderTopColor: t.line, borderRadius: 0 }
          : { backgroundColor: surface.bone, borderColor: surface.glassRim, ...shadows.softCard },
      ]}
      accessibilityLabel={`agent-action-${row.action_type}`}
    >
      <Pressable
        onPress={() => onOpenDetail?.(row)}
        accessibilityLabel="Åbn handlingsdetaljer"
        accessibilityRole="button"
      >
        <View style={styles.row}>
          <Text style={styles.badge}>✓ Udført</Text>
          <Text style={styles.title}>{TITLES[row.action_type] ?? 'Handling udført'}</Text>
        </View>
        {detailFor(row) ? <Text style={styles.detail}>{detailFor(row)}</Text> : null}
      </Pressable>
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
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 8,
    gap: 6,
    overflow: 'hidden',
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
