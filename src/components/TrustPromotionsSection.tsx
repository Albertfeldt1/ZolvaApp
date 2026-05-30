import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { revertTrustOffer, useTrustOffers } from '../lib/trust-offers';
import { colors } from '../theme';

export function TrustPromotionsSection() {
  const { user } = useAuth();
  const { rows, loading } = useTrustOffers(user?.id);
  const accepted = rows.filter((r) => r.status === 'accepted');

  const revert = useCallback(async (id: string) => {
    await revertTrustOffer(id);
  }, []);

  if (!user || loading || accepted.length === 0) return null;

  return (
    <View style={styles.section} accessibilityLabel="trust-promotions">
      <Text style={styles.title}>Auto-sender</Text>
      <Text style={styles.body}>
        Zolva sender automatisk svar til disse modtagere. Tryk for at fjerne.
      </Text>
      {accepted.map((p) => (
        <View key={p.id} style={styles.row}>
          <Text style={styles.rowLabel}>{p.recipient}</Text>
          <Pressable
            onPress={() => revert(p.id)}
            style={styles.revertBtn}
            accessibilityLabel={`revert-${p.id}`}
          >
            <Text style={styles.revertText}>Fjern</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingVertical: 16, gap: 8 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  rowLabel: { color: colors.ink, fontSize: 15, flexShrink: 1 },
  revertBtn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, backgroundColor: '#0001' },
  revertText: { color: colors.ink, fontSize: 13 },
});
