// Slet konto — Papir-udgave af det klassiske bekræftelses-flow (K2).
//
// Mountes både fra PapirSettings (absolut overlay) og den klassiske
// SettingsScreen (Modal). Den klassiske mount har ingen SafeAreaProvider,
// så vi bruger fast top-padding i stedet for useSafeAreaInsets (samme
// lærestreg som AuthSheet).
import { X } from 'lucide-react-native';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { ScaleButton } from '../design/motion';
import {
  Button,
  PaperText,
  papirColor,
  papirFont,
  papirRadius,
  papirSpace,
} from '../design/papir';
import { useAuth } from '../lib/auth';
import { isDemoUser } from '../lib/demo';
import { supabase } from '../lib/supabase';

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
        // Demo accounts don't exist in Supabase - just log the user out
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
          message: `Sletning afbrudt: ${detail}. Prøv igen - dine data er ved at blive ryddet, og et gentaget forsøg fortsætter hvor det slap.`,
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
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.root}>
        {/* Toplinje: rød eyebrow til venstre, stille luk-knap til højre. */}
        <View style={styles.topRow}>
          <PaperText role="eyebrow" color={papirColor.red}>
            Slet konto
          </PaperText>
          <ScaleButton
            scaleTo={0.9}
            haptic="light"
            onPress={onClose}
            disabled={busy}
            hitSlop={10}
            accessibilityLabel="Luk"
            accessibilityRole="button"
            style={styles.closeButton}
          >
            <X size={18} color={papirColor.ink} strokeWidth={2} />
          </ScaleButton>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: papirSpace.screen,
            paddingBottom: 48,
            gap: papirSpace.base,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Advarsels-arket: ét hvidt kort bærer hele konsekvensteksten. */}
          <View style={styles.card}>
            <PaperText accessibilityRole="header" style={styles.headline}>
              Er du sikker?
            </PaperText>

            <View style={styles.divider} />

            <PaperText role="body" color={papirColor.ink2}>
              Hvis du sletter din konto, fjerner vi permanent:
            </PaperText>

            {/* Consequences list */}
            <View style={{ gap: papirSpace.sm }}>
              {[
                'Din Zolva-konto og login',
                'Alle forbindelser til Google og Microsoft',
                'Push-tokens så vi ikke kan sende dig notifikationer',
                'Al data tilknyttet din bruger-ID hos os',
              ].map((item) => (
                <View key={item} style={styles.bulletRow}>
                  <View style={styles.bulletDot} />
                  <PaperText role="body" color={papirColor.ink2} style={{ flex: 1 }}>
                    {item}
                  </PaperText>
                </View>
              ))}
            </View>

            <View style={styles.divider} />

            <PaperText role="body" color={papirColor.ink2}>
              Vi forsøger også at tilbagekalde dine OAuth-tokens hos Google.
              Microsoft understøtter ikke tilbagekaldelse via API - du kan selv
              fjerne adgangen i din Microsoft-konto bagefter.
            </PaperText>

            <PaperText role="bodyStrong" color={papirColor.red}>
              Handlingen kan ikke fortrydes.
            </PaperText>
          </View>

          {stage === 'intro' ? (
            <>
              <Button
                label="Fortsæt til bekræftelse"
                variant="red"
                onPress={() => setStage('confirm')}
                style={{ marginTop: papirSpace.sm }}
              />
              <Button label="Behold min konto" variant="ghost" onPress={onClose} />
            </>
          ) : (
            <>
              {/* Bekræftelses-kortet: skriv SLET for at låse knappen op. */}
              <View style={styles.card}>
                <PaperText role="body" color={papirColor.ink2}>
                  Skriv{' '}
                  <PaperText role="bodyStrong" color={papirColor.ink}>
                    SLET
                  </PaperText>{' '}
                  for at bekræfte.
                </PaperText>

                <TextInput
                  style={styles.input}
                  value={confirmation}
                  onChangeText={setConfirmation}
                  placeholder="SLET"
                  placeholderTextColor={papirColor.ink4}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!busy}
                  accessibilityLabel="Bekræftelse, skriv SLET"
                />
              </View>

              {/* Fejlbanner — rød tekst på redSoft-flade. */}
              {error && (
                <View style={styles.errorCard}>
                  <PaperText role="small" color={papirColor.red}>
                    {error.message}
                  </PaperText>
                </View>
              )}

              <Button
                label="Slet konto permanent"
                variant="red"
                onPress={() => void runDelete()}
                disabled={!typedCorrectly || busy}
                left={busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : undefined}
              />
              <Button label="Annullér" variant="ghost" onPress={onClose} disabled={busy} />
            </>
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: papirColor.paper,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: papirSpace.screen,
    paddingTop: 56,
    paddingBottom: papirSpace.base,
  },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: papirRadius.pill,
    borderWidth: 1,
    borderColor: papirColor.line,
    backgroundColor: papirColor.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: papirColor.card,
    borderWidth: 1,
    borderColor: papirColor.line,
    borderRadius: papirRadius.xl,
    padding: papirSpace.xl,
    gap: papirSpace.base,
  },
  headline: {
    fontFamily: papirFont.displayLight,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.5,
    color: papirColor.ink,
  },
  divider: {
    height: 1,
    backgroundColor: papirColor.lineSoft,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: papirRadius.pill,
    backgroundColor: papirColor.red,
    marginTop: 8,
  },
  input: {
    backgroundColor: papirColor.paper,
    borderRadius: papirRadius.md,
    borderWidth: 1,
    borderColor: papirColor.line,
    paddingHorizontal: papirSpace.base,
    paddingVertical: papirSpace.base,
    fontFamily: papirFont.uiSemi,
    fontSize: 16,
    letterSpacing: 2,
    color: papirColor.ink,
  },
  errorCard: {
    backgroundColor: papirColor.redSoft,
    borderRadius: papirRadius.md,
    padding: papirSpace.base,
  },
});

// Supabase wraps non-2xx responses in FunctionsHttpError whose `.context` is
// the raw Response. The default .message ("Edge Function returned a non-2xx
// status code") hides the status and body - pull them out so the user (and
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
