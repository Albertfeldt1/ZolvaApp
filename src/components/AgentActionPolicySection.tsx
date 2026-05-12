import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { colors } from '../theme';

type ActionType =
  | 'mail.archive'
  | 'mail.label'
  | 'mail.flag_important'
  | 'mail.summarize'
  | 'mail.draft_reply'
  | 'mail.send_reply';
type Mode = 'auto' | 'propose' | 'off';

const ROWS: Array<{ key: ActionType; label: string; defaultMode: Mode }> = [
  { key: 'mail.archive', label: 'Arkivering', defaultMode: 'auto' },
  { key: 'mail.label', label: 'Mærkning', defaultMode: 'auto' },
  { key: 'mail.flag_important', label: 'Markér som vigtig', defaultMode: 'auto' },
  { key: 'mail.summarize', label: 'Opsummering', defaultMode: 'auto' },
  { key: 'mail.draft_reply', label: 'Udkast til svar', defaultMode: 'auto' },
  { key: 'mail.send_reply', label: 'Send svar', defaultMode: 'propose' },
];

const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'auto', label: 'Auto' },
  { key: 'propose', label: 'Spørg' },
  { key: 'off', label: 'Fra' },
];

export function AgentActionPolicySection() {
  const { user } = useAuth();
  const [policy, setPolicy] = useState<Record<ActionType, Mode>>({} as Record<ActionType, Mode>);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from('user_agent_policy')
        .select('action_type, mode')
        .eq('user_id', user.id);
      const next: Record<string, Mode> = {};
      for (const row of (data ?? []) as Array<{ action_type: string; mode: Mode }>) {
        next[row.action_type] = row.mode;
      }
      setPolicy(next as Record<ActionType, Mode>);
      setLoading(false);
    })();
  }, [user?.id]);

  const set = useCallback(async (actionType: ActionType, mode: Mode) => {
    if (!user) return;
    setPolicy((p) => ({ ...p, [actionType]: mode }));
    await supabase.from('user_agent_policy').upsert(
      { user_id: user.id, action_type: actionType, mode, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,action_type' },
    );
  }, [user?.id]);

  if (!user) return null;

  return (
    <View style={styles.section} accessibilityLabel="agent-action-policy">
      <Text style={styles.title}>Pr. handling</Text>
      <Text style={styles.body}>Vælg hvornår Zolva må handle på egen hånd.</Text>
      {ROWS.map((r) => {
        const mode = policy[r.key] ?? r.defaultMode;
        return (
          <View key={r.key} style={styles.row}>
            <Text style={styles.rowLabel}>{r.label}</Text>
            <View style={styles.modes}>
              {MODES.map((m) => (
                <Pressable
                  key={m.key}
                  onPress={() => set(r.key, m.key)}
                  disabled={loading}
                  style={[styles.modeBtn, mode === m.key && styles.modeBtnActive]}
                  accessibilityLabel={`${r.key}-${m.key}`}
                >
                  <Text style={[styles.modeText, mode === m.key && styles.modeTextActive]}>{m.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingVertical: 16, gap: 8 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 },
  rowLabel: { color: colors.ink, fontSize: 15, flexShrink: 1 },
  modes: { flexDirection: 'row', gap: 6 },
  modeBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: '#0001' },
  modeBtnActive: { backgroundColor: colors.ink },
  modeText: { color: colors.ink, fontSize: 13 },
  modeTextActive: { color: '#fff' },
});
