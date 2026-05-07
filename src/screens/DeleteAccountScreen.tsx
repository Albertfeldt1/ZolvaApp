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
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { useTheme } from '../design/useTheme';
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
  const { t, type, fonts, radius, spacing, surface } = useTheme();
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
      <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
        <GlassHaloLayer />

        {/* Header - glass card with close button + eyebrow */}
        <View
          style={{
            paddingTop: spacing.statusBarFallback,
            paddingHorizontal: spacing.screenPad,
            paddingBottom: spacing.cardPad,
            position: 'relative',
            zIndex: 1,
          }}
        >
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  letterSpacing: 0.88,
                  textTransform: 'uppercase',
                  // '#D14343' - no danger token in current scheme; Zolva destructive red
                  color: '#D14343',
                }}
              >
                Slet konto
              </Text>
              <Pressable
                onPress={onClose}
                hitSlop={10}
                style={({ pressed }) => [
                  {
                    width: 34,
                    height: 34,
                    borderRadius: radius.pill,
                    backgroundColor: surface.iconButton,
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                  pressed && { opacity: 0.6 },
                ]}
                accessibilityLabel="Luk"
                accessibilityRole="button"
                disabled={busy}
              >
                <X size={20} color={t.ink} strokeWidth={2} />
              </Pressable>
            </View>
          </GlassFrostedCard>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: spacing.screenPad,
            paddingBottom: 48,
            gap: spacing.cardPad,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Hero warning card */}
          <GlassFrostedCard overlay={surface.bone} radius={radius.card} style={{ padding: spacing.lg }}>
            <Text
              style={{
                fontFamily: fonts.display,
                fontStyle: 'italic',
                fontSize: 32,
                lineHeight: 38,
                letterSpacing: -0.96,
                color: t.ink,
              }}
            >
              Er du sikker?
            </Text>

            <View
              style={{
                marginTop: spacing.md,
                height: 1,
                backgroundColor: t.ink,
                opacity: 0.12,
              }}
            />

            <Text
              style={{
                marginTop: spacing.md,
                fontFamily: fonts.ui,
                fontSize: 15,
                lineHeight: 22,
                color: t.ink2,
              }}
            >
              Hvis du sletter din konto, fjerner vi permanent:
            </Text>

            {/* Consequences list */}
            <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
              {[
                'Din Zolva-konto og login',
                'Alle forbindelser til Google og Microsoft',
                'Push-tokens så vi ikke kan sende dig notifikationer',
                'Al data tilknyttet din bruger-ID hos os',
              ].map((item) => (
                <View key={item} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <View
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 999,
                      // '#D14343' - destructive bullet accent, no token
                      backgroundColor: '#D14343',
                      marginTop: 8,
                    }}
                  />
                  <Text
                    style={{
                      flex: 1,
                      fontFamily: fonts.ui,
                      fontSize: 14.5,
                      lineHeight: 21,
                      color: t.ink2,
                    }}
                  >
                    {item}
                  </Text>
                </View>
              ))}
            </View>

            <View
              style={{
                marginTop: spacing.md,
                height: 1,
                backgroundColor: t.ink,
                opacity: 0.12,
              }}
            />

            <Text
              style={{
                marginTop: spacing.md,
                fontFamily: fonts.ui,
                fontSize: 15,
                lineHeight: 22,
                color: t.ink2,
              }}
            >
              Vi forsøger også at tilbagekalde dine OAuth-tokens hos Google.
              Microsoft understøtter ikke tilbagekaldelse via API - du kan selv
              fjerne adgangen i din Microsoft-konto bagefter.
            </Text>

            <Text
              style={{
                marginTop: spacing.sm,
                fontFamily: fonts.uiBold,
                fontSize: 15,
                lineHeight: 22,
                // '#D14343' - irreversible warning, no token
                color: '#D14343',
              }}
            >
              Handlingen kan ikke fortrydes.
            </Text>
          </GlassFrostedCard>

          {stage === 'intro' ? (
            <>
              {/* "Continue to confirmation" - destructive red pill */}
              <Pressable
                style={({ pressed }) => [
                  {
                    marginTop: spacing.sm,
                    // '#D14343' - destructive CTA background, no token
                    backgroundColor: '#D14343',
                    paddingVertical: 14,
                    borderRadius: radius.pill,
                    alignItems: 'center',
                  },
                  pressed && { opacity: 0.82 },
                ]}
                onPress={() => setStage('confirm')}
                accessibilityRole="button"
              >
                <Text
                  style={{
                    // '#FFFFFF' - white text on destructive red pill
                    color: '#FFFFFF',
                    fontFamily: fonts.uiBold,
                    fontSize: 14.5,
                  }}
                >
                  Fortsæt til bekræftelse
                </Text>
              </Pressable>

              {/* Cancel - ghost */}
              <Pressable
                style={({ pressed }) => [
                  { paddingVertical: 14, alignItems: 'center' },
                  pressed && { opacity: 0.6 },
                ]}
                onPress={onClose}
                accessibilityRole="button"
              >
                <Text
                  style={{
                    color: t.ink3,
                    fontFamily: fonts.uiBold,
                    fontSize: 13,
                  }}
                >
                  Behold min konto
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              {/* Confirmation input card */}
              <GlassFrostedCard overlay={surface.bone} radius={radius.card} style={{ padding: spacing.lg }}>
                <Text
                  style={{
                    fontFamily: fonts.ui,
                    fontSize: 15,
                    lineHeight: 22,
                    color: t.ink2,
                  }}
                >
                  Skriv{' '}
                  <Text style={{ fontFamily: fonts.uiBold, color: t.ink }}>SLET</Text>
                  {' '}for at bekræfte.
                </Text>

                <TextInput
                  style={{
                    marginTop: spacing.md,
                    backgroundColor: '#FFFFFF',
                    borderRadius: radius.card - 4,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: t.line,
                    paddingHorizontal: 14,
                    paddingVertical: 14,
                    fontFamily: fonts.monoBold,
                    fontSize: 16,
                    letterSpacing: 2,
                    color: t.ink,
                  }}
                  value={confirmation}
                  onChangeText={setConfirmation}
                  placeholder="SLET"
                  placeholderTextColor={t.ink4}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!busy}
                  accessibilityLabel="Bekræftelse, skriv SLET"
                />
              </GlassFrostedCard>

              {/* Error banner */}
              {error && (
                <GlassFrostedCard
                  overlay={surface.warningTint}
                  radius={radius.card}
                  style={{ padding: spacing.cardPad }}
                >
                  <Text
                    style={{
                      fontFamily: fonts.ui,
                      fontSize: 13,
                      lineHeight: 19,
                      // '#D14343' - error text, no token
                      color: '#D14343',
                    }}
                  >
                    {error.message}
                  </Text>
                </GlassFrostedCard>
              )}

              {/* Delete permanently - destructive red pill (enabled) / glass pill (disabled) */}
              <Pressable
                style={({ pressed }) => [
                  {
                    paddingVertical: 14,
                    borderRadius: radius.pill,
                    alignItems: 'center',
                    backgroundColor: typedCorrectly && !busy
                      // '#D14343' - destructive CTA enabled, no token
                      ? '#D14343'
                      : surface.glass,
                  },
                  !typedCorrectly || busy
                    ? { opacity: 0.5 }
                    : pressed
                    ? { opacity: 0.82 }
                    : undefined,
                ]}
                onPress={runDelete}
                disabled={!typedCorrectly || busy}
                accessibilityRole="button"
                accessibilityState={{ disabled: !typedCorrectly || busy }}
              >
                {busy ? (
                  // '#FFFFFF' - spinner on dark destructive pill
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text
                    style={{
                      fontFamily: fonts.uiBold,
                      fontSize: 14.5,
                      // '#FFFFFF' when enabled (on red), t.ink3 when disabled (on glass)
                      color: typedCorrectly ? '#FFFFFF' : t.ink3,
                    }}
                  >
                    Slet konto permanent
                  </Text>
                )}
              </Pressable>

              {/* Cancel - ghost */}
              <Pressable
                style={({ pressed }) => [
                  { paddingVertical: 14, alignItems: 'center' },
                  pressed && { opacity: 0.6 },
                ]}
                onPress={onClose}
                disabled={busy}
                accessibilityRole="button"
              >
                <Text
                  style={{
                    color: t.ink3,
                    fontFamily: fonts.uiBold,
                    fontSize: 13,
                  }}
                >
                  Annullér
                </Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

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
