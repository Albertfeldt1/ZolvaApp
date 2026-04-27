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
import { extractDomain, requestAdminConsentLink } from '../lib/admin-consent';
import { colors, fonts } from '../theme';

type Props = {
  prefilledEmail?: string;
  onCancel: () => void;
};

type ScreenError = 'unauthorized' | 'bad-request' | 'network' | 'internal';

function errorMessage(e: ScreenError): string {
  switch (e) {
    case 'unauthorized': return 'Du skal være logget ind for at sende en anmodning.';
    case 'bad-request':  return 'Vi kunne ikke læse mailen. Tjek at du har skrevet en gyldig arbejdsmail.';
    case 'network':      return 'Ingen forbindelse. Prøv igen om lidt.';
    case 'internal':     return 'Noget gik galt. Prøv igen om lidt.';
  }
}

export function MicrosoftAdminConsentScreen({ prefilledEmail, onCancel }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();
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
    const t = setTimeout(() => setCopyToast(false), 1800);
    return () => clearTimeout(t);
  }, [copyToast]);

  const onGenerate = async () => {
    setErrorCode(null);
    const domain = extractDomain(email);
    if (!domain) { setErrorCode('bad-request'); return; }
    setBusy(true);
    const res = await requestAdminConsentLink(domain);
    setBusy(false);
    if (!res.ok) { setErrorCode(res.error.code); return; }
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
      'Mere information om Zolva: https://zolva.io',
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
      style={[styles.flex, { transform: [{ translateY }] }]}
      {...panResponder.panHandlers}
    >
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
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>FORBIND OUTLOOK</Text>
          <Text style={styles.heroH1}>Din organisation kræver godkendelse</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.body}>
            Zolva skal godkendes af en administrator i din organisation, før du kan forbinde din arbejdsmail. Det er en sikkerhedsindstilling, som din IT-afdeling har sat op.
          </Text>
          <Text style={[styles.body, styles.bodySpaced]}>
            Send dette link til din administrator. Når de har godkendt Zolva, kan du og dine kolleger forbinde jeres konti.
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>Din arbejdsmail</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={(t) => { setEmail(t); setErrorCode(null); setLinkUrl(null); }}
              placeholder="navn@firma.dk"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              editable={!busy}
            />
          </View>

          {!linkUrl && (
            <Pressable
              onPress={onGenerate}
              disabled={busy || !email}
              style={[styles.submitBtn, (busy || !email) && styles.submitBtnDisabled]}
              accessibilityRole="button"
            >
              <Text style={styles.submitBtnText}>
                {busy ? 'Henter link…' : 'Hent godkendelseslink'}
              </Text>
            </Pressable>
          )}

          {errorCode && <Text style={styles.errorBox}>{errorMessage(errorCode)}</Text>}

          {linkUrl && (
            <View style={styles.linkBlock}>
              <Text style={styles.linkLabel}>Godkendelseslink til {tenantDomain}</Text>
              <Text style={styles.linkUrl} numberOfLines={3}>{linkUrl}</Text>

              <Pressable onPress={sendEmail} style={styles.primaryBtn} accessibilityRole="button">
                <Mail size={16} color={colors.paper} />
                <Text style={styles.primaryBtnText}>Send link til IT-administrator</Text>
              </Pressable>

              <Pressable onPress={copyLink} style={styles.secondaryBtn} accessibilityRole="button">
                <Copy size={16} color={colors.ink} />
                <Text style={styles.secondaryBtnText}>{copyToast ? 'Kopieret' : 'Kopiér link'}</Text>
              </Pressable>

              <Text style={styles.footHint}>
                Det er en engangsgodkendelse for hele organisationen.
              </Text>
            </View>
          )}

          <Pressable onPress={onCancel} style={styles.cancelBtn} accessibilityRole="button">
            <Text style={styles.cancelBtnText}>Luk</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.paper },
  scroll: { flexGrow: 1, backgroundColor: colors.paper },
  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56, paddingBottom: 22, paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line,
  },
  eyebrow: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.88,
    textTransform: 'uppercase', color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 12, fontFamily: fonts.displayItalic, fontSize: 32,
    lineHeight: 36, letterSpacing: -1, color: colors.ink,
  },
  section: { paddingHorizontal: 20, paddingTop: 24 },
  body: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.ink },
  bodySpaced: { marginTop: 12 },
  field: { marginTop: 24, gap: 6 },
  label: {
    fontFamily: fonts.uiSemi, fontSize: 12, letterSpacing: 0.4,
    textTransform: 'uppercase', color: colors.fg3,
  },
  input: {
    fontFamily: fonts.ui, fontSize: 15, color: colors.ink,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12,
    backgroundColor: colors.paper,
  },
  submitBtn: {
    marginTop: 24, backgroundColor: colors.ink,
    paddingVertical: 14, borderRadius: 8, alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.paper },
  errorBox: {
    marginTop: 16, padding: 12, borderRadius: 8,
    backgroundColor: colors.warningSoft,
    fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, color: colors.warningInk,
  },
  linkBlock: {
    marginTop: 24, padding: 16,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    backgroundColor: colors.mist,
    gap: 12,
  },
  linkLabel: {
    fontFamily: fonts.uiSemi, fontSize: 12, letterSpacing: 0.4,
    textTransform: 'uppercase', color: colors.fg3,
  },
  linkUrl: {
    fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, color: colors.ink,
  },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.sageDeep,
    paddingVertical: 12, borderRadius: 8,
  },
  primaryBtnText: {
    fontFamily: fonts.uiSemi, fontSize: 14, color: colors.paper,
  },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  secondaryBtnText: {
    fontFamily: fonts.uiSemi, fontSize: 14, color: colors.ink,
  },
  footHint: {
    fontFamily: fonts.ui, fontSize: 12, lineHeight: 18, color: colors.fg3,
    textAlign: 'center', marginTop: 4,
  },
  cancelBtn: { marginTop: 12, paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: { fontFamily: fonts.ui, fontSize: 14, color: colors.fg3 },
});
