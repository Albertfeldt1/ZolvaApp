import { X } from 'lucide-react-native';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../lib/auth';
import { isDemoUser } from '../lib/demo';
import { supabase } from '../lib/supabase';
import { colors, fonts } from '../theme';

const CONFIRMATION_WORD = 'SLET';

type Props = {
  onClose: () => void;
  onDeleted: () => void;
};

type DeleteError = { message: string; canRetry: boolean };

export function DeleteAccountScreen({ onClose, onDeleted }: Props) {
  const { user, signOut } = useAuth();
  const [confirmation, setConfirmation] = useState('');
  const [stage, setStage] = useState<'intro' | 'confirm'>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DeleteError | null>(null);

  const demo = isDemoUser(user);
  const typedCorrectly = confirmation.trim().toUpperCase() === CONFIRMATION_WORD;

  const runDelete = async () => {
    if (busy || !typedCorrectly) return;
    setBusy(true);
    setError(null);
    try {
      if (demo) {
        // Demo accounts don't exist in Supabase — just log the user out
        // locally so the UI behaves like a deletion succeeded.
        await signOut();
        onDeleted();
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        setError({ message: 'Din session er udløbet. Log ind igen.', canRetry: false });
        setBusy(false);
        return;
      }

      const { data, error: fnError } = await supabase.functions.invoke('delete-account', {
        method: 'POST',
      });

      if (fnError) {
        const detail = await extractFunctionError(fnError);
        setError({
          message: detail ?? fnError.message ?? 'Noget gik galt under sletningen. Prøv igen.',
          canRetry: true,
        });
        setBusy(false);
        return;
      }

      const ok = (data as { ok?: boolean } | null)?.ok === true;
      if (!ok) {
        const detail = (data as { error?: string } | null)?.error ?? 'Ukendt fejl';
        setError({
          message: `Sletning afbrudt: ${detail}. Prøv igen — dine data er ved at blive ryddet, og et gentaget forsøg fortsætter hvor det slap.`,
          canRetry: true,
        });
        setBusy(false);
        return;
      }

      // Success: wipe the local session so the app returns to LoginCard.
      try {
        await supabase.auth.signOut();
      } catch {
        // The auth user is gone server-side; a local signOut failure is fine.
      }
      onDeleted();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError({ message: msg, canRetry: true });
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
          accessibilityLabel="Luk"
          accessibilityRole="button"
          disabled={busy}
        >
          <X size={22} color={colors.ink} strokeWidth={2} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.eyebrow}>Slet konto</Text>
        <Text style={styles.title}>Er du sikker?</Text>

        <Text style={styles.body}>
          Hvis du sletter din konto, fjerner vi permanent:
        </Text>
        <View style={styles.list}>
          <BulletItem>Din Zolva-konto og login</BulletItem>
          <BulletItem>Alle forbindelser til Google og Microsoft</BulletItem>
          <BulletItem>Push-tokens så vi ikke kan sende dig notifikationer</BulletItem>
          <BulletItem>Al data tilknyttet din bruger-ID hos os</BulletItem>
        </View>

        <Text style={[styles.body, { marginTop: 16 }]}>
          Vi forsøger også at tilbagekalde dine OAuth-tokens hos Google.
          Microsoft understøtter ikke tilbagekaldelse via API — du kan selv
          fjerne adgangen i din Microsoft-konto bagefter.
        </Text>

        <Text style={[styles.body, styles.warn]}>
          Handlingen kan ikke fortrydes.
        </Text>

        {stage === 'intro' ? (
          <>
            <Pressable
              style={({ pressed }) => [styles.primaryDestructive, pressed && styles.pressed]}
              onPress={() => setStage('confirm')}
              accessibilityRole="button"
            >
              <Text style={styles.primaryDestructiveText}>Fortsæt til bekræftelse</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
              onPress={onClose}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>Behold min konto</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.body, { marginTop: 20 }]}>
              Skriv <Text style={styles.bodyStrong}>SLET</Text> for at
              bekræfte.
            </Text>

            <TextInput
              style={styles.input}
              value={confirmation}
              onChangeText={setConfirmation}
              placeholder="SLET"
              placeholderTextColor={colors.fg3}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!busy}
              accessibilityLabel="Bekræftelse, skriv SLET"
            />

            {error && (
              <Text style={styles.errorText}>{error.message}</Text>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.primaryDestructive,
                (!typedCorrectly || busy) && styles.disabled,
                pressed && typedCorrectly && !busy && styles.pressed,
              ]}
              onPress={runDelete}
              disabled={!typedCorrectly || busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: !typedCorrectly || busy }}
            >
              {busy ? (
                <ActivityIndicator color={colors.paper} />
              ) : (
                <Text style={styles.primaryDestructiveText}>
                  Slet konto permanent
                </Text>
              )}
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
              onPress={onClose}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>Annullér</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Supabase wraps non-2xx responses in FunctionsHttpError whose `.context` is
// the raw Response. The default .message ("Edge Function returned a non-2xx
// status code") hides the status and body — pull them out so the user (and
// the logs) see what actually failed.
async function extractFunctionError(err: unknown): Promise<string | null> {
  const ctx = (err as { context?: unknown })?.context;
  if (!ctx || typeof (ctx as Response).clone !== 'function') return null;
  const res = (ctx as Response).clone();
  const status = res.status;
  let body = '';
  try {
    body = await res.text();
  } catch {
    // fall through
  }
  const parsed = body ? safeParseJson(body) : null;
  const detail =
    (parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error?: unknown }).error ?? '')
      : '') || body.slice(0, 200);
  console.warn(`[delete-account] fn error status=${status} body=${body}`);
  return detail ? `${detail} (HTTP ${status})` : `HTTP ${status}`;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function BulletItem({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bullet} />
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 8,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    backgroundColor: colors.mist,
  },
  pressed: { opacity: 0.6 },
  scroll: {
    paddingHorizontal: 20,
    paddingBottom: 48,
    gap: 12,
  },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.danger,
  },
  title: {
    fontFamily: fonts.displayItalic,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -1.08,
    color: colors.ink,
    marginBottom: 8,
  },
  body: {
    fontFamily: fonts.ui,
    fontSize: 15,
    lineHeight: 22,
    color: colors.fg2,
  },
  bodyStrong: {
    fontFamily: fonts.uiSemi,
    color: colors.ink,
  },
  warn: {
    marginTop: 12,
    color: colors.danger,
    fontFamily: fonts.uiSemi,
  },
  list: {
    marginTop: 12,
    gap: 8,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  bullet: {
    width: 5,
    height: 5,
    borderRadius: 999,
    backgroundColor: colors.danger,
    marginTop: 9,
  },
  bulletText: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.fg2,
  },
  input: {
    marginTop: 10,
    backgroundColor: colors.mist,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontFamily: fonts.monoSemi,
    fontSize: 16,
    letterSpacing: 2,
    color: colors.ink,
  },
  errorText: {
    marginTop: 10,
    fontFamily: fonts.ui,
    fontSize: 13,
    lineHeight: 19,
    color: colors.danger,
  },
  primaryDestructive: {
    marginTop: 20,
    backgroundColor: colors.danger,
    paddingVertical: 14,
    borderRadius: 999,
    alignItems: 'center',
  },
  primaryDestructiveText: {
    color: colors.paper,
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
  },
  disabled: {
    opacity: 0.4,
  },
  secondary: {
    marginTop: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryText: {
    color: colors.fg3,
    fontFamily: fonts.uiSemi,
    fontSize: 13,
  },
});
