// src/screens/MicrosoftAdminConsentScreen.tsx
//
// Shown when a user attempts to connect Outlook/Microsoft and the tenant
// requires admin consent. Asks the user for their work email, mints an
// admin-consent URL via microsoft-admin-consent-link, and lets them mail
// or copy the URL to their IT administrator.
//
// Papir re-skin: paper background, eyebrow + serif headline, white cards on
// paper (border = papirColor.line), stacked full-width Buttons — same visual
// language as AuthSheet ("Titelbladet") and MemoryConsentModal. All logic
// (prefill, link minting, error mapping, mailto/copy, pull-to-dismiss) is
// unchanged.

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
import {
  BreathingWave,
  Button,
  PaperText,
  papirColor,
  papirFont,
  papirRadius,
  papirSpace,
} from '../design/papir';

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
      style={[styles.flex, { backgroundColor: papirColor.paper, transform: [{ translateY }] }]}
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
        {/* Toplinje: eyebrow + serif-overskrift til venstre, stille "Luk" til højre. */}
        <View style={styles.topRow}>
          <View style={{ flex: 1 }}>
            <PaperText role="eyebrow" color={papirColor.ink3}>
              Forbind Outlook
            </PaperText>
            <PaperText style={styles.headline} accessibilityRole="header">
              Admin-samtykke
            </PaperText>
          </View>
          <Pressable
            onPress={onCancel}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Luk"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <PaperText role="small" color={papirColor.ink3}>
              Luk
            </PaperText>
          </Pressable>
        </View>

        {/* Forklaringskortet: bølgen er brand-tråden fra Titelbladet. */}
        <View style={styles.card}>
          <View style={{ alignItems: 'flex-start' }}>
            <BreathingWave />
          </View>
          <PaperText style={styles.cardTitle}>
            Din organisation kræver godkendelse
          </PaperText>
          <PaperText role="body" color={papirColor.ink2}>
            Zolva skal godkendes af en administrator i din organisation, før du kan forbinde din
            arbejdsmail. Det er en sikkerhedsindstilling, som din IT-afdeling har sat op.
          </PaperText>
          <PaperText role="body" color={papirColor.ink2}>
            Send dette link til din administrator. Når de har godkendt Zolva, kan du og dine
            kolleger forbinde jeres konti.
          </PaperText>
        </View>

        {/* Mail-input + hent-link kortet. */}
        <View style={styles.card}>
          {/* Email field */}
          <View style={{ gap: papirSpace.sm }}>
            <PaperText role="eyebrow" color={papirColor.ink3}>
              Din arbejdsmail
            </PaperText>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={(tx) => { setEmail(tx); setErrorCode(null); setLinkUrl(null); }}
              placeholder="navn@firma.dk"
              placeholderTextColor={papirColor.ink3}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              editable={!busy}
            />
          </View>

          {/* Generate link button */}
          {!linkUrl && (
            <Button
              label={busy ? 'Henter link…' : 'Hent godkendelseslink'}
              variant="primary"
              disabled={busy || !email}
              onPress={() => void onGenerate()}
            />
          )}

          {/* Error state */}
          {errorCode && (
            <View style={styles.errorBox}>
              <PaperText role="small" color={papirColor.red}>
                {errorMessage(errorCode)}
              </PaperText>
            </View>
          )}

          {/* Link result block */}
          {linkUrl && (
            <View style={styles.resultBox}>
              <PaperText role="eyebrow" color={papirColor.ink3}>
                Godkendelseslink til {tenantDomain}
              </PaperText>
              <PaperText style={styles.linkText} numberOfLines={3}>
                {linkUrl}
              </PaperText>

              {/* Send to IT */}
              <Button
                label="Send link til IT-administrator"
                variant="primary"
                left={<Mail size={16} color={papirColor.onInk} />}
                onPress={() => void sendEmail()}
              />

              {/* Copy link */}
              <Button
                label={copyToast ? 'Kopieret' : 'Kopiér link'}
                variant="ghost"
                left={<Copy size={16} color={papirColor.ink} />}
                onPress={() => void copyLink()}
              />

              <PaperText role="caption" color={papirColor.ink3} style={styles.resultNote}>
                Det er en engangsgodkendelse for hele organisationen.
              </PaperText>
            </View>
          )}

          {/* Cancel ghost */}
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            style={({ pressed }) => [styles.cancelGhost, { opacity: pressed ? 0.5 : 1 }]}
          >
            <PaperText role="small" color={papirColor.ink3}>
              Luk
            </PaperText>
          </Pressable>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: papirSpace.screen,
    paddingTop: 68,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: papirSpace.md,
  },
  headline: {
    fontFamily: papirFont.displayLight,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.5,
    color: papirColor.ink,
    marginTop: papirSpace.xs,
  },
  card: {
    backgroundColor: papirColor.card,
    borderWidth: 1,
    borderColor: papirColor.line,
    borderRadius: papirRadius.xl,
    padding: papirSpace.xl,
    gap: papirSpace.lg,
    marginTop: papirSpace.lg,
  },
  cardTitle: {
    fontFamily: papirFont.display,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.4,
    color: papirColor.ink,
  },
  input: {
    fontFamily: papirFont.ui,
    fontSize: 15,
    color: papirColor.ink,
    backgroundColor: papirColor.card,
    borderWidth: 1,
    borderColor: papirColor.line,
    borderRadius: papirRadius.lg,
    paddingHorizontal: papirSpace.base,
    paddingVertical: papirSpace.md,
  },
  errorBox: {
    padding: papirSpace.md,
    borderRadius: papirRadius.md,
    backgroundColor: papirColor.redSoft,
  },
  resultBox: {
    gap: papirSpace.md,
    padding: papirSpace.lg,
    borderRadius: papirRadius.lg,
    borderWidth: 1,
    borderColor: papirColor.line,
    backgroundColor: papirColor.paper2,
  },
  linkText: {
    fontFamily: papirFont.ui,
    fontSize: 12,
    lineHeight: 18,
    color: papirColor.ink2,
  },
  resultNote: {
    textAlign: 'center',
    marginTop: papirSpace.xs,
  },
  cancelGhost: {
    paddingVertical: papirSpace.md,
    alignItems: 'center',
  },
});
