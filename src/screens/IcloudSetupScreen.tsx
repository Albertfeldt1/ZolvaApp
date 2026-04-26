// src/screens/IcloudSetupScreen.tsx
import { useEffect, useState } from 'react';
import {
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Eye, EyeOff } from 'lucide-react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { useAuth } from '../lib/auth';
import { saveCredential } from '../lib/icloud-credentials';
import { validate as validateImap } from '../lib/icloud-mail';
import { probeCredential as probeCalDav } from '../lib/icloud-calendar';
import { colors, fonts } from '../theme';

type Props = {
  prefilledEmail?: string;
  onDone: () => void;
  onCancel: () => void;
};

const APPLE_ID_URL = 'https://appleid.apple.com/account/manage';
const APPLE_DOMAINS = ['@me.com', '@icloud.com', '@mac.com'];

type SubmitError =
  | 'auth-failed'
  | 'network'
  | 'timeout'
  | 'rate-limited'
  | 'protocol';

export function IcloudSetupScreen({ prefilledEmail, onDone, onCancel }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();
  const { user } = useAuth();
  const [email, setEmail] = useState(prefilledEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [pwdWarning, setPwdWarning] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [busy, setBusy] = useState(false);

  // Clear errors when app comes back from background — user may have gone
  // to fix something in Apple settings and returned.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setSubmitError(null);
    });
    return () => sub.remove();
  }, []);

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
      : 'Det ligner ikke en app-specifik adgangskode (xxxx-xxxx-xxxx-xxxx). Tjek at du har genereret en ny adgangskode på Apples side — din normale Apple-adgangskode virker ikke her.');
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
    try {
      const [imapRes, calRes] = await Promise.all([
        validateImap(email, password),
        probeCalDav(email, password),
      ]);
      if (!imapRes.ok) { setSubmitError(mapToSubmitError(imapRes.error)); return; }
      if (!calRes.ok)  { setSubmitError(mapToSubmitError(calRes.error)); return; }
      await saveCredential(user.id, email, password);
      onDone();
    } catch {
      setSubmitError('protocol');
    } finally {
      setBusy(false);
    }
  };

  const submitDisabled = !email || !password || busy;

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom + 32 }]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>FORBIND ICLOUD</Text>
        <Text style={styles.heroH1}>Forbind iCloud</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.body}>
          Apple kræver en særlig adgangskode (én til hver app), så Zolva kan læse din mail og kalender. Du laver den selv på Apples side — det tager omkring et minut.
        </Text>

        <View style={styles.guide}>
          <Step n="1" title="Åbn Apples side">
            <Pressable style={styles.primaryBtn} onPress={openAppleId} accessibilityRole="button">
              <Text style={styles.primaryBtnText}>Åbn appleid.apple.com</Text>
            </Pressable>
          </Step>
          <Step n="2" title='Tryk på "Sign-In and Security" → "App-Specific Passwords"'>
            {/* TODO Task 10.3: replace placeholder with actual screenshot asset */}
            <View style={styles.screenshotPlaceholder}>
              <Text style={styles.screenshotPlaceholderText}>[Skærmbillede tilføjes]</Text>
            </View>
          </Step>
          <Step n="3" title='Generér en ny adgangskode og navngiv den "Zolva"'>
            <Text style={styles.warn}>Apple viser kun adgangskoden én gang. Kopiér den med det samme.</Text>
          </Step>
          <Step n="4" title="Skift tilbage til Zolva og udfyld nedenfor" />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>iCloud-email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={(t) => { setEmail(t); setSubmitError(null); }}
            onBlur={onEmailBlur}
            placeholder="navn@me.com / @icloud.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
          />
          {emailWarning && <Text style={styles.warn}>{emailWarning}</Text>}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>App-specifik adgangskode</Text>
          <View style={styles.pwdRow}>
            <TextInput
              style={[styles.input, styles.pwdInput]}
              value={password}
              onChangeText={onPwdChange}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              secureTextEntry={!showPwd}
            />
            <Pressable
              onPress={() => setShowPwd((v) => !v)}
              style={styles.eyeBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={showPwd ? 'Skjul adgangskode' : 'Vis adgangskode'}
            >
              {showPwd ? <EyeOff size={18} color={colors.fg3} /> : <Eye size={18} color={colors.fg3} />}
            </Pressable>
          </View>
          {pwdWarning && <Text style={styles.warn}>{pwdWarning}</Text>}
        </View>

        {submitError && (
          <Text style={styles.errorBox}>{messageFor(submitError)}</Text>
        )}

        <Pressable
          onPress={onSubmit}
          disabled={submitDisabled}
          style={[styles.submitBtn, submitDisabled && styles.submitBtnDisabled]}
          accessibilityRole="button"
        >
          <Text style={styles.submitBtnText}>
            {busy ? 'Tester forbindelse…' : 'Forbind'}
          </Text>
        </Pressable>

        <Pressable onPress={onCancel} style={styles.cancelBtn} accessibilityRole="button">
          <Text style={styles.cancelBtnText}>Annullér</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Step({ n, title, children }: { n: string; title: string; children?: React.ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepHeadRow}>
        <Text style={styles.stepNum}>{n}</Text>
        <Text style={styles.stepTitle}>{title}</Text>
      </View>
      {children && <View style={styles.stepBody}>{children}</View>}
    </View>
  );
}

function mapToSubmitError(code: string): SubmitError {
  if (code === 'auth-failed' || code === 'network' || code === 'timeout' || code === 'rate-limited' || code === 'protocol') {
    return code;
  }
  return 'protocol';
}

function messageFor(e: SubmitError): string {
  switch (e) {
    case 'auth-failed':  return 'Forkert email eller adgangskode. Tjek at du har lavet en app-specifik adgangskode (ikke din normale Apple-adgangskode).';
    case 'network':      return 'Ingen forbindelse til Apple. Tjek dit internet og prøv igen.';
    case 'timeout':      return 'Apple svarer ikke. Prøv igen om lidt.';
    case 'rate-limited': return 'For mange forsøg. Prøv igen om en time.';
    case 'protocol':     return 'Noget gik galt på Apples side. Prøv igen om lidt.';
  }
}

const styles = StyleSheet.create({
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
    marginTop: 12, fontFamily: fonts.displayItalic, fontSize: 36,
    lineHeight: 40, letterSpacing: -1.08, color: colors.ink,
  },
  section: { paddingHorizontal: 20, paddingTop: 24 },
  body: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.ink },
  guide: { marginTop: 24, gap: 18 },
  step: { gap: 8 },
  stepHeadRow: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  stepNum: {
    fontFamily: fonts.display, fontSize: 22, color: colors.sageDeep, width: 22,
  },
  stepTitle: {
    flex: 1, fontFamily: fonts.uiSemi, fontSize: 14, lineHeight: 20, color: colors.ink,
  },
  stepBody: { paddingLeft: 34 },
  primaryBtn: {
    backgroundColor: colors.sageDeep,
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8,
    alignItems: 'center', alignSelf: 'flex-start',
  },
  primaryBtnText: {
    fontFamily: fonts.uiSemi, fontSize: 14, color: colors.paper,
  },
  screenshotPlaceholder: {
    height: 120, backgroundColor: colors.mist, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  screenshotPlaceholderText: {
    fontFamily: fonts.mono, fontSize: 11, color: colors.fg3,
  },
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
  pwdRow: { position: 'relative' },
  pwdInput: { fontFamily: fonts.mono, paddingRight: 44 },
  eyeBtn: {
    position: 'absolute', right: 8, top: 0, bottom: 0,
    width: 36, alignItems: 'center', justifyContent: 'center',
  },
  warn: {
    marginTop: 4,
    fontFamily: fonts.ui, fontSize: 12, lineHeight: 18, color: colors.warningInk,
  },
  errorBox: {
    marginTop: 16, padding: 12, borderRadius: 8,
    backgroundColor: colors.warningSoft,
    fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, color: colors.warningInk,
  },
  submitBtn: {
    marginTop: 24, backgroundColor: colors.ink,
    paddingVertical: 14, borderRadius: 8, alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: {
    fontFamily: fonts.uiSemi, fontSize: 15, color: colors.paper,
  },
  cancelBtn: { marginTop: 12, paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: {
    fontFamily: fonts.ui, fontSize: 14, color: colors.fg3,
  },
});
