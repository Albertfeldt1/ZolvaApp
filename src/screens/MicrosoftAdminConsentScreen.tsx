// src/screens/MicrosoftAdminConsentScreen.tsx
//
// Shown when a user attempts to connect Outlook/Microsoft and the tenant
// requires admin consent. Asks the user for their work email, mints an
// admin-consent URL via microsoft-admin-consent-link, and lets them mail
// or copy the URL to their IT administrator.

import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Linking,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Copy, Mail } from 'lucide-react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import {
  extractDomain,
  isPersonalEmailDomain,
  requestAdminConsentLink,
} from '../lib/admin-consent';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';

type Props = {
  prefilledEmail?: string;
  onCancel: () => void;
};

type ScreenError = 'unauthorized' | 'bad-request' | 'personal-domain' | 'network' | 'internal';

function errorMessage(e: ScreenError): string {
  switch (e) {
    case 'unauthorized':    return 'Du skal være logget ind for at sende en anmodning.';
    case 'bad-request':     return 'Vi kunne ikke læse mailen. Tjek at du har skrevet en gyldig arbejdsmail.';
    case 'personal-domain': return 'Brug din Microsoft 365-arbejdsmail (fx navn@firma.dk). En privat mail som gmail.com eller icloud.com kan ikke godkende Zolva for en organisation.';
    case 'network':         return 'Ingen forbindelse. Prøv igen om lidt.';
    case 'internal':        return 'Noget gik galt. Prøv igen om lidt.';
  }
}

export function MicrosoftAdminConsentScreen({ prefilledEmail, onCancel }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();
  const { t, type, fonts, radius, spacing, surface } = useTheme();

  const [email, setEmail] = useState(prefilledEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ScreenError | null>(null);
  const [copyToast, setCopyToast] = useState(false);

  // Match IcloudSetupScreen's pull-to-dismiss gesture.
  const translateY = useRef(new Animated.Value(0)).current;
  const atTopRef = useRef(true);
  const screenH = Dimensions.get('window').height;
  const PULL_CAP = 96;
  const DISMISS_DY = 80;
  const DISMISS_VY = 0.6;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        atTopRef.current && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        if (g.dy <= 0) { translateY.setValue(0); return; }
        const damped = (1 - 1 / (g.dy * 0.55 / PULL_CAP + 1)) * PULL_CAP;
        translateY.setValue(damped);
      },
      onPanResponderRelease: (_, g) => {
        const commit = g.dy > DISMISS_DY || g.vy > DISMISS_VY;
        if (commit) {
          Animated.timing(translateY, { toValue: screenH, duration: 220, useNativeDriver: true })
            .start(() => onCancel());
        } else {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4, speed: 16 }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  useEffect(() => {
    if (!copyToast) return;
    const tmr = setTimeout(() => setCopyToast(false), 1800);
    return () => clearTimeout(tmr);
  }, [copyToast]);

  const onGenerate = async () => {
    setErrorCode(null);
    const domain = extractDomain(email);
    if (!domain) { setErrorCode('bad-request'); return; }
    // Short-circuit personal domains client-side so the user gets the
    // dedicated error copy instead of the generic "bad-request" string the
    // edge function returns.
    if (isPersonalEmailDomain(domain)) { setErrorCode('personal-domain'); return; }
    setBusy(true);
    const res = await requestAdminConsentLink(domain);
    setBusy(false);
    if (!res.ok) {
      const code =
        res.error.code === 'bad-request' && /personal/i.test(res.error.detail ?? '')
          ? 'personal-domain'
          : res.error.code;
      setErrorCode(code);
      return;
    }
    setLinkUrl(res.data.url);
  };

  const tenantDomain = extractDomain(email) ?? '';

  const sendEmail = async () => {
    if (!linkUrl) return;
    const subject = `Godkendelse af Zolva til ${tenantDomain}`;
    const bodyLines = [
      'Hej,',
      '',
      'Jeg vil gerne bruge Zolva, en personlig AI-assistent der hjælper med at organisere min arbejdsdag. Appen skal have adgang til min mail og kalender for at fungere, og vores Microsoft 365-opsætning kræver, at en administrator godkender appen for hele organisationen.',
      '',
      'Du kan se og godkende anmodningen her:',
      linkUrl,
      '',
      'Til vurdering af appen:',
      '• Databehandleraftale (GDPR art. 28): https://albertfeldt1.github.io/ZolvaApp/dpa-da.html',
      '• Privatlivspolitik: https://albertfeldt1.github.io/ZolvaApp/privacy-policy-da.html',
      '• Vilkår for brug: https://albertfeldt1.github.io/ZolvaApp/terms-da.html',
      '• Mere om Zolva: https://zolva.io',
      '',
      'Tak.',
    ];
    const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.join('\n'))}`;
    try { await Linking.openURL(url); } catch { /* user can use Copy as fallback */ }
  };

  const copyLink = async () => {
    if (!linkUrl) return;
    await Clipboard.setStringAsync(linkUrl);
    setCopyToast(true);
  };

  return (
    <Animated.View
      style={[styles.flex, { backgroundColor: t.paper, transform: [{ translateY }] }]}
      {...panResponder.panHandlers}
    >
      {/* Halo background */}
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        <GlassHaloLayer />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom + 32 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        bounces={false}
        overScrollMode="never"
        scrollEventThrottle={16}
        onScroll={(e) => { atTopRef.current = e.nativeEvent.contentOffset.y <= 0; }}
      >
        {/* Header glass card */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.xl + 12 }}>
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.cardPad }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Pressable
                onPress={onCancel}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Luk"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: radius.pill,
                  backgroundColor: surface.iconButton,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontFamily: fonts.ui, fontSize: 18, color: t.ink2 }}>×</Text>
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={{ ...type.eyebrow, color: t.ink3 }}>FORBIND OUTLOOK</Text>
                <Text
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 20,
                    letterSpacing: -0.4,
                    color: t.ink,
                    marginTop: 2,
                  }}
                >
                  Admin-samtykke
                </Text>
              </View>
            </View>
          </GlassFrostedCard>
        </View>

        {/* Hero explainer card */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.lg }}>
          <GlassFrostedCard overlay={surface.bone} style={{ padding: spacing.xl, gap: spacing.lg }}>
            <View style={{ alignItems: 'center' }}>
              <Stone size={48} jumpOnTap={false} />
            </View>
            <Text
              style={{
                fontFamily: fonts.display,
                fontSize: 22,
                lineHeight: 28,
                letterSpacing: -0.6,
                color: t.ink,
              }}
            >
              Din organisation kræver godkendelse
            </Text>
            <Text style={{ ...type.body, color: t.ink2, lineHeight: 22 }}>
              Zolva skal godkendes af en administrator i din organisation, før du kan forbinde din
              arbejdsmail. Det er en sikkerhedsindstilling, som din IT-afdeling har sat op.
            </Text>
            <Text style={{ ...type.body, color: t.ink2, lineHeight: 22 }}>
              Send dette link til din administrator. Når de har godkendt Zolva, kan du og dine
              kolleger forbinde jeres konti.
            </Text>
          </GlassFrostedCard>
        </View>

        {/* Email input + generate button card */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.lg }}>
          <GlassFrostedCard overlay={surface.bone} style={{ padding: spacing.xl, gap: spacing.lg }}>
            {/* Email field */}
            <View style={{ gap: spacing.xs }}>
              <Text style={{ ...type.eyebrow, color: t.ink3 }}>Din arbejdsmail</Text>
              <TextInput
                style={{
                  fontFamily: fonts.ui,
                  fontSize: 15,
                  color: t.ink,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: t.line,
                  borderRadius: radius.cardSm,
                  paddingHorizontal: 12,
                  paddingVertical: 12,
                  backgroundColor: '#FFFFFF',
                }}
                value={email}
                onChangeText={(tx) => { setEmail(tx); setErrorCode(null); setLinkUrl(null); }}
                placeholder="navn@firma.dk"
                placeholderTextColor={t.ink4}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                editable={!busy}
              />
            </View>

            {/* Generate link button */}
            {!linkUrl && (
              <Pressable
                onPress={onGenerate}
                disabled={busy || !email}
                style={{
                  backgroundColor: t.ink,
                  paddingVertical: 14,
                  borderRadius: radius.soft,
                  alignItems: 'center',
                  opacity: busy || !email ? 0.4 : 1,
                }}
                accessibilityRole="button"
              >
                <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: surface.glassDarkText }}>
                  {busy ? 'Henter link…' : 'Hent godkendelseslink'}
                </Text>
              </Pressable>
            )}

            {/* Error state */}
            {errorCode && (
              <View
                style={{
                  padding: spacing.md,
                  borderRadius: radius.cardSm,
                  backgroundColor: surface.warningTint,
                }}
              >
                <Text style={{ ...type.bodySm, color: t.today, lineHeight: 19 }}>
                  {errorMessage(errorCode)}
                </Text>
              </View>
            )}

            {/* Link result block */}
            {linkUrl && (
              <View
                style={{
                  gap: spacing.md,
                  padding: spacing.lg,
                  borderRadius: radius.cardSm,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: t.line,
                  backgroundColor: surface.scrim,
                }}
              >
                <Text style={{ ...type.eyebrow, color: t.ink3 }}>
                  Godkendelseslink til {tenantDomain}
                </Text>
                <Text
                  style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, color: t.ink }}
                  numberOfLines={3}
                >
                  {linkUrl}
                </Text>

                {/* Send to IT */}
                <Pressable
                  onPress={sendEmail}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: spacing.sm,
                    backgroundColor: t.ink,
                    paddingVertical: 12,
                    borderRadius: radius.soft,
                  }}
                  accessibilityRole="button"
                >
                  <Mail size={16} color={surface.glassDarkText} />
                  <Text style={{ fontFamily: fonts.uiBold, fontSize: 14, color: surface.glassDarkText }}>
                    Send link til IT-administrator
                  </Text>
                </Pressable>

                {/* Copy link */}
                <Pressable
                  onPress={copyLink}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: spacing.sm,
                    paddingVertical: 12,
                    borderRadius: radius.soft,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: t.line,
                    backgroundColor: '#FFFFFF',
                  }}
                  accessibilityRole="button"
                >
                  <Copy size={16} color={t.ink} />
                  <Text style={{ fontFamily: fonts.uiBold, fontSize: 14, color: t.ink }}>
                    {copyToast ? 'Kopieret' : 'Kopiér link'}
                  </Text>
                </Pressable>

                <Text
                  style={{
                    ...type.bodySm,
                    color: t.ink3,
                    textAlign: 'center',
                    marginTop: spacing.xs,
                  }}
                >
                  Det er en engangsgodkendelse for hele organisationen.
                </Text>
              </View>
            )}

            {/* Cancel ghost */}
            <Pressable
              onPress={onCancel}
              style={{ paddingVertical: 12, alignItems: 'center' }}
              accessibilityRole="button"
            >
              <Text style={{ fontFamily: fonts.ui, fontSize: 14, color: t.ink3 }}>Luk</Text>
            </Pressable>
          </GlassFrostedCard>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },
});
