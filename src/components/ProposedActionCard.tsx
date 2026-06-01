import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import {
  approveProposedAction,
  dismissProposedAction,
  type ProposedActionRow,
} from '../lib/agent-proposals';
import { useTheme } from '../design/useTheme';
import { colors } from '../theme';

function previewBody(row: ProposedActionRow): string {
  const b = row.preview.body;
  return typeof b === 'string' ? b : '';
}

function previewTitle(row: ProposedActionRow): string {
  const t = row.preview.title;
  return typeof t === 'string' ? t : 'Zolva foreslår';
}

// "Send" reads wrong for a calendar event; use a neutral confirm verb for
// non-mail proposals.
function confirmLabel(row: ProposedActionRow): string {
  const mailTypes = new Set(['mail.send_reply', 'mail.draft_reply', 'mail.send_new']);
  return mailTypes.has(row.action_type) ? 'Send' : 'Godkend';
}

type Props = {
  row: ProposedActionRow;
  /** Called when the user taps the title/body area to open the detail modal. */
  onOpenDetail: () => void;
  /**
   * When true, the card renders flush inside a parent card: no horizontal
   * margin, no own surface/shadow, and a hairline top divider instead.
   */
  embedded?: boolean;
};

export function ProposedActionCard({ row, onOpenDetail, embedded = false }: Props) {
  const { surface, shadows, t } = useTheme();
  const [pending, setPending] = useState<'send' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSend() {
    setPending('send');
    setError(null);
    // Quick-approve: sends the original draft without edits.
    // Edits live in ProposalDetailModal (opened via onOpenDetail).
    const r = await approveProposedAction(row.id, undefined);
    setPending(null);
    if (!r.ok) setError(r.error ?? 'fejl');
  }

  async function onSkip() {
    setPending('skip');
    setError(null);
    await dismissProposedAction(row.id);
    setPending(null);
  }

  return (
    <View
      style={[
        styles.card,
        embedded
          ? { marginHorizontal: 0, borderWidth: 0, borderTopWidth: 1, borderTopColor: t.line, borderRadius: 0 }
          : { backgroundColor: surface.bone, borderColor: surface.glassRim, ...shadows.softCard },
      ]}
      accessibilityLabel={`proposed-${row.action_type}`}
    >
      {/* Tappable title+body area — opens the full detail modal */}
      <Pressable onPress={onOpenDetail} accessibilityLabel="Åbn detaljer" accessibilityRole="button">
        <Text style={styles.title}>{previewTitle(row)}</Text>
        <Text style={styles.body} numberOfLines={3}>{previewBody(row)}</Text>
      </Pressable>

      <View style={styles.actions}>
        <Pressable onPress={onSend} disabled={!!pending} style={styles.primary} accessibilityLabel="send">
          {pending === 'send' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{confirmLabel(row)}</Text>}
        </Pressable>
        <Pressable onPress={onSkip} disabled={!!pending} accessibilityLabel="skip">
          {pending === 'skip' ? <ActivityIndicator size="small" /> : <Text style={styles.secondary}>Spring over</Text>}
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 8,
    gap: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  primary: { backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  secondary: { color: colors.ink, fontSize: 14, fontWeight: '500', textDecorationLine: 'underline' },
  error: { color: '#A24', fontSize: 12 },
});
