import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { decideTrustOffer, type TrustOfferRow } from '../lib/trust-offers';
import { colors } from '../theme';

export function TrustOfferCard({ row }: { row: TrustOfferRow }) {
  const { user } = useAuth();
  const [pending, setPending] = useState<'yes' | 'no' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(status: 'accepted' | 'dismissed') {
    if (!user) return;
    setPending(status === 'accepted' ? 'yes' : 'no');
    setError(null);
    const r = await decideTrustOffer(row.id, user.id, status);
    setPending(null);
    if (!r.ok) setError('fejl');
  }

  return (
    <View style={styles.card} accessibilityLabel={`trust-offer-${row.id}`}>
      <Text style={styles.title}>Sende automatisk fremover?</Text>
      <Text style={styles.body}>
        Du har godkendt mine svar til <Text style={styles.bold}>{row.recipient}</Text> {row.approval_count} gange.
        Skal jeg sende dem direkte fremover?
      </Text>
      <View style={styles.actions}>
        <Pressable onPress={() => decide('accepted')} disabled={!!pending} style={styles.primary} accessibilityLabel="trust-offer-yes">
          {pending === 'yes' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Ja, send automatisk</Text>}
        </Pressable>
        <Pressable onPress={() => decide('dismissed')} disabled={!!pending} accessibilityLabel="trust-offer-no">
          {pending === 'no' ? <ActivityIndicator size="small" /> : <Text style={styles.secondary}>Nej tak</Text>}
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
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
    gap: 8,
    borderWidth: 1,
    borderColor: colors.ink + '22',
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '600', color: colors.ink },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  primary: { backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  secondary: { color: colors.ink, fontSize: 14, fontWeight: '500', textDecorationLine: 'underline' },
  error: { color: '#A24', fontSize: 12 },
});
