import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, ActivityIndicator } from 'react-native';
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

// Only mail replies support an editable body server-side (agent-approve splices
// edited_body only for mail.send_reply). Other proposal types (e.g. calendar
// writes) are approve-or-skip with no inline edit.
function isEditable(row: ProposedActionRow): boolean {
  return row.action_type === 'mail.send_reply';
}

// "Send" reads wrong for a calendar event; use a neutral confirm verb for
// non-mail proposals.
function confirmLabel(row: ProposedActionRow): string {
  return row.action_type === 'mail.send_reply' ? 'Send' : 'Godkend';
}

export function ProposedActionCard({ row }: { row: ProposedActionRow }) {
  const { surface, shadows } = useTheme();
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(previewBody(row));
  const [pending, setPending] = useState<'send' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSend() {
    setPending('send');
    setError(null);
    const r = await approveProposedAction(row.id, editing ? edited : undefined);
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
      style={[styles.card, { backgroundColor: surface.bone, borderColor: surface.glassRim, ...shadows.softCard }]}
      accessibilityLabel={`proposed-${row.action_type}`}
    >
      <Text style={styles.title}>{previewTitle(row)}</Text>
      {editing && isEditable(row) ? (
        <TextInput
          value={edited}
          onChangeText={setEdited}
          multiline
          style={styles.input}
          accessibilityLabel="edit-body"
        />
      ) : (
        <Text style={styles.body}>{previewBody(row)}</Text>
      )}
      <View style={styles.actions}>
        <Pressable onPress={onSend} disabled={!!pending} style={styles.primary} accessibilityLabel="send">
          {pending === 'send' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{confirmLabel(row)}</Text>}
        </Pressable>
        {isEditable(row) ? (
          <Pressable onPress={() => setEditing((v) => !v)} disabled={!!pending} accessibilityLabel="edit">
            <Text style={styles.secondary}>{editing ? 'Annullér' : 'Rediger'}</Text>
          </Pressable>
        ) : null}
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
  input: { color: colors.ink, fontSize: 14, lineHeight: 20, minHeight: 64, padding: 4, backgroundColor: '#fff', borderRadius: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  primary: { backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  secondary: { color: colors.ink, fontSize: 14, fontWeight: '500', textDecorationLine: 'underline' },
  error: { color: '#A24', fontSize: 12 },
});
