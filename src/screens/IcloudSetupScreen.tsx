// src/screens/IcloudSetupScreen.tsx
//
// Papir-udgaven af iCloud-opsætningen. Skærmen er et session-overlay der
// renderes oven på Papir-UI'et, så den følger Papir-sproget: papir-baggrund,
// hvide kort med hairline-kant, serif-tal i terracotta og BreathingWave som
// brand-tråd. Al logik (validering, fejl-mapping, pull-to-dismiss, AppState-
// reset) er uændret fra den klassiske udgave — kun præsentationen er ny.
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Dimensions,
  Image,
  Linking,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { ChevronLeft, Eye, EyeOff } from 'lucide-react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { useAuth } from '../lib/auth';
import { saveCredential, IcloudLinkFailure } from '../lib/icloud-credentials';
import { setIntegrationEnabled } from '../lib/integration-flags';
import { validate as validateImap } from '../lib/icloud-mail';
import { probeCredential as probeCalDav } from '../lib/icloud-calendar';
import {
  BreathingWave,
  Button,
  IconButton,
  PaperText,
  papirColor,
  papirFont,
  papirRadius,
  papirSpace,
  papirType,
} from '../design/papir';

type Props = {
  prefilledEmail?: string;
  onDone: () => void;
  onCancel: () => void;
};

const APPLE_ID_URL = 'https://appleid.apple.com/account/manage';
const APPLE_DOMAINS = ['@me.com', '@icloud.com', '@mac.com'];

// Fixed top padding instead of safe-area insets: this overlay can mount from
// the classic App.tsx tree, which has no SafeAreaProvider (same lesson as
// AuthSheet — useSafeAreaInsets would throw there).
const TOP_PAD = 56;

type SubmitError =
  | 'auth-failed'
  | 'network'
  | 'timeout'
  | 'rate-limited'
  | 'temporarily-unavailable'
  | 'gateway-unavailable'
  | 'protocol'
  | 'reauth-required'
  | 'voice-link-failed';

export function IcloudSetupScreen({ prefilledEmail, onDone, onCancel }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();
  const { user } = useAuth();

  const [email, setEmail] = useState(prefilledEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [pwdWarning, setPwdWarning] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  // DEV-ONLY: surface the underlying exception message for the 'protocol'
  // fallback so we don't need Metro to debug. Cleared on every submit.
  const [devDebugError, setDevDebugError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Clear errors when app comes back from background - user may have gone
  // to fix something in Apple settings and returned.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setSubmitError(null);
    });
    return () => sub.remove();
  }, []);

  // Pull-to-dismiss: rubber-band cap on downward drag from scroll-top, commit
  // past a distance/velocity threshold by sliding off-screen and calling
  // onCancel. ScrollView's own bounce is disabled so this is the only pull
  // affordance.
  const translateY = useRef(new Animated.Value(0)).current;
  const atTopRef = useRef(true);
  const screenH = Dimensions.get('window').height;
  const PULL_CAP = 96;     // rubber-band asymptote in px
  const DISMISS_DY = 80;   // raw drag distance to commit dismiss
  const DISMISS_VY = 0.6;  // vertical velocity to commit dismiss

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
          Animated.timing(translateY, {
            toValue: screenH,
            duration: 220,
            useNativeDriver: true,
          }).start(() => onCancel());
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 4,
            speed: 16,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  const onEmailBlur = () => {
    if (!email) { setEmailWarning(null); return; }
    const lower = email.trim().toLowerCase();
    const ok = APPLE_DOMAINS.some((d) => lower.endsWith(d));
    setEmailWarning(ok ? null
      : 'iCloud kræver en @me.com, @icloud.com eller @mac.com adresse. Tjek at du har skrevet din iCloud-mail (ikke fx @gmail.com).');
  };

  const onPwdChange = (next: string) => {
    setPassword(next);
    setSubmitError(null);
    if (next.length < 8) { setPwdWarning(null); return; }
    const stripped = next.replace(/[\s-]/g, '');
    const looksRight = /^[a-z]{16}$/.test(stripped);
    setPwdWarning(looksRight ? null
      : 'Det ligner ikke en app-specifik adgangskode (xxxx-xxxx-xxxx-xxxx). Tjek at du har genereret en ny adgangskode på Apples side - din normale Apple-adgangskode virker ikke her.');
  };

  const openAppleId = async () => {
    try {
      await WebBrowser.openBrowserAsync(APPLE_ID_URL);
    } catch {
      void Linking.openURL(APPLE_ID_URL);
    }
  };

  const onSubmit = async () => {
    if (!user?.id) { setSubmitError('auth-failed'); return; }
    setBusy(true);
    setSubmitError(null);
    setDevDebugError(null);
    try {
      const [imapRes, calRes] = await Promise.all([
        validateImap(email, password),
        probeCalDav(email, password),
      ]);
      if (!imapRes.ok) { setSubmitError(mapToSubmitError(imapRes.error)); return; }
      if (!calRes.ok)  { setSubmitError(mapToSubmitError(calRes.error)); return; }
      try {
        await saveCredential(user.id, email, password);
        // Re-enable the iCloud integration flag whenever creds are
        // successfully (re-)entered. Users who reach this screen via the
        // Inbox "Apple afviste adgangskoden" banner never touch the
        // Settings toggle, so without this the flag can stay 'false' from
        // a prior toggle-off and the row stays visually disconnected even
        // though the credential is now valid.
        await setIntegrationEnabled('icloud', true);
      } catch (linkErr) {
        if (linkErr instanceof IcloudLinkFailure) {
          if (linkErr.code === 'reauth-required') { setSubmitError('reauth-required'); return; }
          if (linkErr.code === 'rate-limited')    { setSubmitError('rate-limited'); return; }
          if (linkErr.code === 'discovery-failed' || linkErr.code === 'network') {
            setSubmitError('network');
            if (__DEV__) setDevDebugError(`saveCredential ${linkErr.code}: ${linkErr.message}`);
            return;
          }
          setSubmitError('voice-link-failed');
          if (__DEV__) setDevDebugError(`saveCredential ${linkErr.code}: ${linkErr.message}`);
          return;
        }
        throw linkErr;
      }
      onDone();
    } catch (err) {
      setSubmitError('protocol');
      if (__DEV__) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        const stack = err instanceof Error ? err.stack ?? '' : '';
        setDevDebugError(`${msg}\n\n${stack.split('\n').slice(0, 5).join('\n')}`);
        console.warn('[icloud-setup] submit threw:', err);
      }
    } finally {
      setBusy(false);
    }
  };

  const submitDisabled = !email || !password || busy;

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
        onScroll={(e) => {
          atTopRef.current = e.nativeEvent.contentOffset.y <= 0;
        }}
      >
        {/* Header: back button + eyebrow/title, direkte på papiret. */}
        <View style={styles.header}>
          <IconButton accessibilityLabel="Gå tilbage" onPress={onCancel}>
            <ChevronLeft size={17} color={papirColor.ink} strokeWidth={2} />
          </IconButton>
          <View style={{ flex: 1 }}>
            <PaperText role="eyebrow" color={papirColor.ink3}>
              FORBIND ICLOUD
            </PaperText>
            <PaperText role="titleSerif" style={{ marginTop: 2 }}>
              Forbind iCloud
            </PaperText>
          </View>
        </View>

        {/* Hero explainer card */}
        <View style={styles.cardWrap}>
          <View style={[styles.card, { gap: papirSpace.base }]}>
            <View style={{ alignItems: 'center' }}>
              <BreathingWave scale={0.8} />
            </View>
            <PaperText role="displayS">App-specifik adgangskode</PaperText>
            <PaperText role="body" color={papirColor.ink2}>
              Apple kræver en særlig adgangskode (én til hver app), så Zolva kan læse din mail og
              kalender. Du laver den selv på Apples side - det tager omkring et minut.
            </PaperText>
          </View>
        </View>

        {/* Step-by-step guide card */}
        <View style={styles.cardWrap}>
          <View style={[styles.card, { gap: papirSpace.lg }]}>
            <Step n="1" title="Åbn Apples side">
              <Button
                label="Åbn appleid.apple.com"
                onPress={() => void openAppleId()}
                style={{ alignSelf: 'flex-start' }}
              />
            </Step>

            <Step n="2" title='Find "App-specifikke adgangskoder" under "Login og sikkerhed"'>
              <Image
                source={require('../../assets/icloud-step-1-find.png')}
                style={styles.stepImage}
                resizeMode="contain"
                accessibilityLabel="Apple-konto siden hvor App-specifikke adgangskoder er fremhævet"
              />
            </Step>

            <Step n="3" title='Generér en ny adgangskode og navngiv den "Zolva"'>
              <Image
                source={require('../../assets/icloud-step-2-name.png')}
                style={styles.stepImage}
                resizeMode="contain"
                accessibilityLabel="Apples dialog hvor app-navnet skrives - vi har skrevet Zolva"
              />
            </Step>

            <Step n="4" title="Kopiér adgangskoden Apple viser dig">
              <Image
                source={require('../../assets/icloud-step-3-reveal.png')}
                style={styles.stepImage}
                resizeMode="contain"
                accessibilityLabel="Apples dialog der viser den nye app-specifikke adgangskode"
              />
              <PaperText role="small" color={papirColor.red} style={{ marginTop: papirSpace.sm }}>
                Apple viser kun adgangskoden én gang. Kopiér den nu - du kan ikke se den igen
                senere.
              </PaperText>
            </Step>

            <Step n="5" title="Skift tilbage til Zolva og udfyld nedenfor" />
          </View>
        </View>

        {/* Input fields card */}
        <View style={styles.cardWrap}>
          <View style={[styles.card, { gap: papirSpace.lg }]}>
            {/* Email field */}
            <View style={{ gap: papirSpace.sm }}>
              <PaperText role="eyebrow" color={papirColor.ink3}>iCloud-email</PaperText>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={(tx) => { setEmail(tx); setSubmitError(null); }}
                onBlur={onEmailBlur}
                placeholder="navn@me.com / @icloud.com"
                placeholderTextColor={papirColor.ink3}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
              />
              {emailWarning && (
                <PaperText role="small" color={papirColor.red}>
                  {emailWarning}
                </PaperText>
              )}
            </View>

            {/* Password field */}
            <View style={{ gap: papirSpace.sm }}>
              <PaperText role="eyebrow" color={papirColor.ink3}>App-specifik adgangskode</PaperText>
              <View style={{ position: 'relative' }}>
                <TextInput
                  style={[styles.input, { paddingRight: 52 }]}
                  value={password}
                  onChangeText={onPwdChange}
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  placeholderTextColor={papirColor.ink3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  secureTextEntry={!showPwd}
                />
                <Pressable
                  onPress={() => setShowPwd((v) => !v)}
                  style={styles.eyeButton}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={showPwd ? 'Skjul adgangskode' : 'Vis adgangskode'}
                >
                  {showPwd
                    ? <EyeOff size={18} color={papirColor.ink3} />
                    : <Eye size={18} color={papirColor.ink3} />}
                </Pressable>
              </View>
              {pwdWarning && (
                <PaperText role="small" color={papirColor.red}>
                  {pwdWarning}
                </PaperText>
              )}
            </View>

            {/* Submit error */}
            {submitError && (
              <View style={styles.errorBox}>
                <PaperText role="small" color={papirColor.red}>
                  {messageFor(submitError)}
                </PaperText>
              </View>
            )}

            {/* DEV debug box */}
            {__DEV__ && devDebugError && (
              <Text
                selectable
                style={{
                  padding: papirSpace.md,
                  borderRadius: papirRadius.md,
                  backgroundColor: '#1a1a1a',
                  fontFamily: 'Menlo',
                  fontSize: 11,
                  lineHeight: 15,
                  // DEV-only green debug text - intentional inline hex
                  color: '#7fffaf',
                }}
              >
                {devDebugError}
              </Text>
            )}

            {/* Submit button */}
            <Button
              label={busy ? 'Tester forbindelse…' : 'Forbind'}
              onPress={() => void onSubmit()}
              disabled={submitDisabled}
              left={busy ? <ActivityIndicator color={papirColor.onInk} size="small" /> : undefined}
            />

            {/* Cancel ghost */}
            <Button variant="ghost" label="Annullér" onPress={onCancel} />
          </View>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

type StepProps = {
  n: string;
  title: string;
  children?: React.ReactNode;
};

function Step({ n, title, children }: StepProps) {
  return (
    <View style={{ gap: papirSpace.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: papirSpace.md }}>
        <PaperText
          color={papirColor.red}
          style={{ fontFamily: papirFont.display, fontSize: 22, lineHeight: 26, width: 22 }}
        >
          {n}
        </PaperText>
        <PaperText role="bodyStrong" style={{ flex: 1 }}>
          {title}
        </PaperText>
      </View>
      {children && <View style={{ paddingLeft: 34 }}>{children}</View>}
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapToSubmitError(code: string): SubmitError {
  if (
    code === 'auth-failed' ||
    code === 'network' ||
    code === 'timeout' ||
    code === 'rate-limited' ||
    code === 'temporarily-unavailable' ||
    code === 'gateway-unavailable' ||
    code === 'protocol'
  ) {
    return code;
  }
  return 'protocol';
}

function messageFor(e: SubmitError): string {
  switch (e) {
    case 'auth-failed':             return 'Forkert email eller adgangskode. Tjek at du har lavet en app-specifik adgangskode (ikke din normale Apple-adgangskode).';
    case 'network':                 return 'Ingen forbindelse. Tjek dit internet og prøv igen.';
    case 'timeout':                 return 'Det tog for lang tid. Prøv igen om lidt.';
    case 'rate-limited':            return 'For mange forsøg. Prøv igen om en time.';
    case 'temporarily-unavailable': return 'Apple er travl lige nu. Prøv igen om lidt.';
    case 'gateway-unavailable':     return 'Vores server kunne ikke nås. Prøv igen om lidt.';
    case 'protocol':                return 'Noget gik galt på Apples side. Prøv igen om lidt.';
    case 'reauth-required':         return 'Log ud og ind igen for at forbinde stemmestyring.';
    case 'voice-link-failed':       return 'iCloud forbindelse oprettet, men stemmestyring kunne ikke registreres. Prøv at forbinde igen.';
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: papirSpace.md,
    paddingHorizontal: papirSpace.screen,
    paddingTop: TOP_PAD,
  },
  cardWrap: {
    paddingHorizontal: papirSpace.screen,
    paddingTop: papirSpace.lg,
  },
  card: {
    backgroundColor: papirColor.card,
    borderWidth: 1,
    borderColor: papirColor.line,
    borderRadius: papirRadius.xl,
    padding: papirSpace.lg,
  },
  stepImage: {
    width: '100%',
    height: 200,
    borderRadius: papirRadius.md,
    // Apple's modal scrim - matches letterbox so it's visually invisible
    backgroundColor: 'rgba(15,16,20,0.05)',
  },
  input: {
    ...papirType.body,
    color: papirColor.ink,
    backgroundColor: papirColor.card,
    borderWidth: 1,
    borderColor: papirColor.line,
    borderRadius: papirRadius.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  eyeButton: {
    position: 'absolute',
    right: 6,
    top: 6,
    bottom: 6,
    width: 38,
    backgroundColor: papirColor.paper2,
    borderRadius: papirRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBox: {
    padding: papirSpace.md,
    borderRadius: papirRadius.md,
    backgroundColor: papirColor.redSoft,
  },
});
