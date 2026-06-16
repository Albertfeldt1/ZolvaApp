import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useAuth } from '../lib/auth';

interface Props {
  /** Called after a successful sign-in or when the user dismisses the sheet. */
  onClose: () => void;
}

type ProviderId = 'apple' | 'google' | 'microsoft';

/**
 * Logged-out sign-in surface. Rendered by App.tsx as an Animated.View overlay
 * (NOT a native Modal — see the iOS modal-stacking lesson). Offers the three
 * real account providers; iCloud mail is connected later, inside onboarding.
 */
export function AuthSheet({ onClose }: Props) {
  const { signInWithApple, signInWithGoogle, signInWithMicrosoft, appleAvailable } = useAuth();
  const [busy, setBusy] = useState<ProviderId | null>(null);

  const run = async (id: ProviderId, fn: () => Promise<unknown>) => {
    if (busy) return;
    try {
      setBusy(id);
      await fn();
      onClose();
    } catch (err) {
      if (__DEV__) console.warn('[auth-sheet] sign-in failed:', err);
    } finally {
      setBusy(null);
    }
  };

  const providers: Array<{ id: ProviderId; label: string; onPress: () => void; show: boolean }> = [
    { id: 'apple', label: 'Fortsæt med Apple', show: appleAvailable, onPress: () => run('apple', signInWithApple) },
    { id: 'google', label: 'Fortsæt med Google', show: true, onPress: () => run('google', signInWithGoogle) },
    { id: 'microsoft', label: 'Fortsæt med Microsoft', show: true, onPress: () => run('microsoft', signInWithMicrosoft) },
  ];

  return (
    <View style={styles.root}>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.dismiss}>
        <Text style={styles.dismissLabel}>Luk</Text>
      </Pressable>
      <Text style={styles.title}>Log ind på Zolva</Text>
      <Text style={styles.subtitle}>Vælg hvordan du vil komme i gang.</Text>
      <View style={styles.buttons}>
        {providers.filter((p) => p.show).map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            onPress={p.onPress}
            disabled={busy !== null}
            style={({ pressed }) => [styles.provider, pressed && styles.pressed]}
          >
            {busy === p.id ? <ActivityIndicator color="#1C1C1A" /> : <Text style={styles.providerLabel}>{p.label}</Text>}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FBFBFA', paddingHorizontal: 24, paddingTop: 72, paddingBottom: 48 },
  dismiss: { alignSelf: 'flex-end', padding: 8 },
  dismissLabel: { fontSize: 16, color: '#6B6B66' },
  title: { fontSize: 28, fontWeight: '700', color: '#1C1C1A', marginTop: 16 },
  subtitle: { fontSize: 16, color: '#6B6B66', marginTop: 8, marginBottom: 32 },
  buttons: { gap: 12 },
  provider: {
    borderWidth: 1,
    borderColor: '#1C1C1A',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  pressed: { opacity: 0.7 },
  providerLabel: { fontSize: 16, fontWeight: '600', color: '#1C1C1A' },
});
