import React from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useAgentEnabled } from '../lib/agent-settings';
import { colors } from '../theme';

export function ZolvaHandlingerSection() {
  const { user } = useAuth();
  const { enabled, loading, setEnabled } = useAgentEnabled(user?.id);

  if (!user) return null;

  return (
    <View style={styles.section} accessibilityLabel="Zolva-handlinger">
      <Text style={styles.title}>Zolva-handlinger</Text>
      <Text style={styles.body}>
        Lad Zolva sortere indbakken og foreslå handlinger i baggrunden. Slå fra for at pause.
      </Text>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Tillad baggrundshandlinger</Text>
        <Switch
          value={enabled}
          onValueChange={(next) => { void setEnabled(next); }}
          disabled={loading}
          accessibilityLabel="agent-enabled-toggle"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingVertical: 16, gap: 8 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  rowLabel: { color: colors.ink, fontSize: 15 },
});
