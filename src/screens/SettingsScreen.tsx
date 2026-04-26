// EXPORT_PATH_DOCUMENTED — The previous "Eksportér alle data" button rendered a
// fake Alert. It was removed (see comment in the Privatliv card below) because a
// broken promise is a GDPR Art. 15 liability. The right-of-access path now lives
// in the privacy policy (owned by T3 in legal/privacy-policy-{da,en}.md): users
// email the contact address and Zolva responds within 30 days. When/if a real
// JSON export is built (Edge Function + Resend), re-add a button here and grep
// for this marker to update the handoff.
import { Check } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageSourcePropType,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
import { makeRedirectUri } from 'expo-auth-session';
import { useChromeInsets } from '../components/PhoneChrome';
import { Stone } from '../components/Stone';
import { useAuth } from '../lib/auth';
import {
  useConnections,
  usePrivacyToggles,
  useSubscription,
  useUser,
  useWorkPreferences,
} from '../lib/hooks';
import { supabase } from '../lib/supabase';
import type { Connection, IntegrationStatus, WorkPreference } from '../lib/types';
import { clearCredential, loadCredential } from '../lib/icloud-credentials';
import { clearDiscoveryCacheFor } from '../lib/icloud-calendar';
import { translateProviderError } from '../utils/danish';

import {
  ensurePermission,
  getPermissionStatus,
  syncOnAppForeground,
  type PermissionStatus,
} from '../lib/notifications';
import {
  getNotificationSettings,
  setNotificationSetting,
  subscribeNotificationSettings,
  type NotificationSettings,
} from '../lib/notification-settings';
import {
  registerPushToken,
  setMailWatchersEnabled,
  unregisterPushToken,
} from '../lib/push';
import { DeleteAccountScreen } from './DeleteAccountScreen';
import { IcloudBriefSheet } from '../components/IcloudBriefSheet';
import { colors, fonts } from '../theme';

// Reads the hosted privacy-policy URL from app.json extra.privacyPolicyUrl
// so legal copy can be swapped without a new binary. Returns null while
// the URL is still a placeholder (so the link gracefully no-ops in dev).
function getPrivacyPolicyUrl(): string | null {
  const raw = Constants.expoConfig?.extra?.privacyPolicyUrl;
  if (typeof raw !== 'string') return null;
  if (!raw || raw.startsWith('TODO_')) return null;
  return raw;
}

const ROW_TRANSITION = LinearTransition.duration(220);
const OPTIONS_ENTER = FadeIn.duration(180);
const OPTIONS_EXIT = FadeOut.duration(140);

const LOGOS: Record<string, ImageSourcePropType> = {
  'google-calendar.png': require('../../assets/logos/google-calendar.png'),
  'gmail.png': require('../../assets/logos/gmail.png'),
  'google-drive.png': require('../../assets/logos/google-drive.png'),
  'outlook-calendar.png': require('../../assets/logos/outlook-calendar.png'),
  'outlook-mail.png': require('../../assets/logos/outlook-mail.png'),
  'icloud.png': require('../../assets/logos/icloud.png'),
};

const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: 'Forbundet',
  pending: 'Venter',
  expired: 'Genindtast adgangskode',
  disconnected: 'Ikke forbundet',
};

function useNotificationSettings(): NotificationSettings {
  const [state, setState] = useState<NotificationSettings>(getNotificationSettings());
  useEffect(() => subscribeNotificationSettings(setState), []);
  return state;
}

function useNotificationPermission(): PermissionStatus {
  const [status, setStatus] = useState<PermissionStatus>('undetermined');
  useEffect(() => {
    let alive = true;
    void getPermissionStatus().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

type SettingsScreenProps = {
  onOpenIcloudSetup?: (prefilledEmail?: string) => void;
  // Bumped by App.tsx whenever the iCloud setup overlay closes, so this
  // screen reloads the credential state without remounting.
  icloudRefreshVersion?: number;
};

export function SettingsScreen({ onOpenIcloudSetup, icloudRefreshVersion = 0 }: SettingsScreenProps) {
  const { data: user, loading: userLoading } = useUser();
  const { data: subscription } = useSubscription();
  const { data: connections, connect, disconnect } = useConnections();
  const { data: workRows, setValue: setWorkValue } = useWorkPreferences();
  const { data: toggles, flip } = usePrivacyToggles();
  const { signOut, user: authUser, googleAccessToken, microsoftAccessToken } = useAuth();
  const userId = authUser?.id ?? '';
  const [icloudCredState, setIcloudCredState] = useState<'absent' | 'valid' | 'invalid'>('absent');
  const [icloudEmail, setIcloudEmail] = useState<string | null>(null);
  const [briefSheetOpen, setBriefSheetOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setIcloudCredState('absent');
      setIcloudEmail(null);
      return;
    }
    void loadCredential(userId).then((c) => {
      if (cancelled) return;
      setIcloudCredState(c.kind);
      setIcloudEmail(c.kind !== 'absent' ? c.credential.email : null);
    });
    return () => { cancelled = true; };
  }, [userId, icloudRefreshVersion]);

  const icloudConnection: Connection = {
    id: 'icloud',
    title: 'iCloud',
    sub:
      icloudCredState === 'valid'   ? (icloudEmail ?? 'Mail og kalender')
    : icloudCredState === 'invalid' ? 'Adgangskoden er afvist'
                                    : 'Mail og kalender',
    status:
      icloudCredState === 'valid'   ? 'connected'
    : icloudCredState === 'invalid' ? 'expired'
                                    : 'disconnected',
    logo: 'icloud.png', // never read — row renderer special-cases iCloud to use the lucide Cloud icon (Apple trademark constraint).
  };
  const allConnections: Connection[] = [icloudConnection, ...connections];

  const hasGoogleOrMicrosoft = !!(googleAccessToken || microsoftAccessToken);
  const hasIcloud = icloudCredState === 'valid';
  const briefVariant: 'normal' | 'icloud-only' =
    !hasGoogleOrMicrosoft && hasIcloud ? 'icloud-only' : 'normal';
  const briefProviderSub = hasGoogleOrMicrosoft
    ? `Bruger din ${googleAccessToken ? 'Gmail' : 'Outlook'} konto`
    : undefined;

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const notificationSettings = useNotificationSettings();
  const permission = useNotificationPermission();

  const openPrivacyPolicy = async () => {
    const url = getPrivacyPolicyUrl();
    if (!url) {
      Alert.alert(
        'Privatlivspolitik',
        'Privatlivspolitikken er ikke publiceret endnu. Skriv til Kontakt@zolva.io for at få en kopi.',
      );
      return;
    }
    try {
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (err) {
      if (__DEV__) console.warn('[settings] privacy policy open failed:', err);
    }
  };

  const toggleNotificationSetting = async (key: keyof NotificationSettings, next: boolean) => {
    if (next) {
      const result = await ensurePermission();
      if (result !== 'granted') {
        Alert.alert(
          'Tillad notifikationer',
          'Zolva kan ikke sende notifikationer før du giver tilladelse i systemindstillingerne.',
          [
            { text: 'Ikke nu', style: 'cancel' },
            { text: 'Åbn indstillinger', onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }
    }

    if (key === 'newMail') {
      if (next) {
        const registration = await registerPushToken();
        if (!registration.ok && registration.reason === 'no-session') {
          Alert.alert('Nye mails', 'Log ind før du aktiverer mail-notifikationer.');
          return;
        }
        if (!registration.ok && !__DEV__) {
          Alert.alert('Nye mails', 'Kunne ikke registrere enheden. Prøv igen om lidt.');
          return;
        }
        // In dev (or when the push token registration soft-failed) we still
        // flip the server-side watcher on so polling runs end-to-end. Push
        // delivery simply no-ops until a real device registers a token.
        await setMailWatchersEnabled(true);
      } else {
        await unregisterPushToken();
        await setMailWatchersEnabled(false);
      }
    }

    await setNotificationSetting(key, next);
    void syncOnAppForeground();
  };

  const handleConnect = async (id: typeof connections[number]['id']) => {
    if (connectingId) return;
    setConnectingId(id);
    const { error } = await connect(id);
    setConnectingId(null);
    if (error) {
      if (__DEV__) console.warn('[auth] connect provider failed:', id, error);
      Alert.alert('Kunne ikke forbinde', translateProviderError(error).message);
    }
  };

  // Per-provider disconnect. A single OAuth grant covers all Google (Gmail +
  // Calendar + Drive) or all Microsoft (Outlook Mail + Calendar), so the
  // confirmation copy tells the user which services they're giving up.
  const disconnectCopy = (id: typeof connections[number]['id']): { title: string; message: string } => {
    const isGoogle = id === 'google-calendar' || id === 'gmail' || id === 'google-drive';
    if (isGoogle) {
      return {
        title: 'Frakobl Google',
        message: 'Zolva mister adgang til Gmail, Google Kalender og Google Drive. Du kan forbinde igen når som helst.',
      };
    }
    return {
      title: 'Frakobl Microsoft',
      message: 'Zolva mister adgang til Outlook Mail og Kalender. Du kan forbinde igen når som helst.',
    };
  };

  const confirmIcloudDisconnect = () => {
    Alert.alert(
      'Frakobl iCloud?',
      'Mails og kalenderbegivenheder fra iCloud forsvinder fra Zolva.',
      [
        { text: 'Annullér', style: 'cancel' },
        {
          text: 'Frakobl', style: 'destructive',
          onPress: async () => {
            if (!userId) return;
            await clearCredential(userId);
            await clearDiscoveryCacheFor(userId);
            setIcloudCredState('absent');
            setIcloudEmail(null);
            // Server-side binding row gets swept by cron after 90 days; no
            // client-callable disconnect endpoint exists in v1.
          },
        },
      ],
    );
  };

  const handleDisconnect = (id: typeof connections[number]['id']) => {
    if (connectingId) return;
    const { title, message } = disconnectCopy(id);
    Alert.alert(title, message, [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Frakobl',
        style: 'destructive',
        onPress: async () => {
          setConnectingId(id);
          const { error } = await disconnect(id);
          setConnectingId(null);
          if (error) {
            if (__DEV__) console.warn('[auth] disconnect provider failed:', id, error);
            Alert.alert('Kunne ikke frakoble', translateProviderError(error).message);
          }
        },
      },
    ]);
  };

  const isLoggedIn = !!user;
  const { bottom: chromeBottom } = useChromeInsets();

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom }]}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>
            {user ? `Konto · ${user.email}` : 'Konto'}
          </Text>
          <Text style={styles.heroH1}>Indstillinger</Text>
        </View>

        {userLoading ? (
          <View style={styles.authLoading}>
            <ActivityIndicator color={colors.sageDeep} />
          </View>
        ) : !isLoggedIn ? (
          <LoginCard />
        ) : (
          <>
            <View style={styles.speech}>
              <Stone mood="calm" size={40} />
              <View style={{ flex: 1 }}>
                <Text style={styles.speechText}>
                  Jeg arbejder sådan her. Skru på det du vil - resten passer jeg.
                </Text>
              </View>
            </View>

            <Animated.View layout={ROW_TRANSITION} style={styles.section}>
              <Text style={styles.sectionTitle}>Sådan arbejder jeg</Text>
              <View style={styles.inkRule} />
              {workRows.map((r) =>
                r.id === 'morning-brief' && briefVariant === 'icloud-only' ? (
                  <View key={r.id} style={styles.disabledPrefRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.workTitle}>{r.title}</Text>
                      <Text style={styles.workMeta}>Kræver Gmail eller Outlook for nu</Text>
                    </View>
                    <Pressable onPress={() => setBriefSheetOpen(true)} hitSlop={8} accessibilityRole="button">
                      <Text style={styles.linkText}>Læs mere</Text>
                    </Pressable>
                  </View>
                ) : (
                  <WorkPreferenceRow
                    key={r.id}
                    pref={r}
                    sub={r.id === 'morning-brief' ? briefProviderSub : undefined}
                    onChange={async (v) => {
                      const result = await setWorkValue(r.id, v);
                      if (result.ok) return;
                      const message =
                        result.reason === 'unauthenticated' || result.reason === 'rls'
                          ? 'Kunne ikke gemme — log ind igen.'
                          : 'Kunne ikke gemme. Prøv igen om lidt.';
                      Alert.alert('Indstillinger', message);
                    }}
                  />
                ),
              )}
            </Animated.View>

            <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
              <Text style={styles.sectionTitle}>Forbundet</Text>
              <View style={styles.inkRule} />
              {allConnections.map((c, i) => {
                const pillStyle =
                  c.status === 'connected' ? styles.statusSage :
                    c.status === 'pending' ? styles.statusWarn :
                      c.status === 'expired' ? styles.statusWarn :
                        styles.statusNeutral;
                const textStyle =
                  c.status === 'connected' ? styles.statusTextSage :
                    c.status === 'pending' ? styles.statusTextWarn :
                      c.status === 'expired' ? styles.statusTextWarn :
                        styles.statusTextNeutral;
                const isConnected = c.status === 'connected';
                // iCloud's expired state is tappable (re-enter flow). Other
                // providers' 'expired' remains non-interactive — no UI yet.
                const tappable =
                  isConnected ||
                  c.status === 'disconnected' ||
                  (c.id === 'icloud' && c.status === 'expired');
                const isBusy = connectingId === c.id;
                const onRowPress =
                  c.id === 'icloud'
                    ? (isConnected
                        ? () => confirmIcloudDisconnect()
                        : () => onOpenIcloudSetup?.(icloudEmail ?? undefined))
                    : (isConnected
                        ? () => handleDisconnect(c.id)
                        : () => handleConnect(c.id));
                return (
                  <Pressable
                    key={c.id}
                    onPress={tappable ? onRowPress : undefined}
                    disabled={!tappable || isBusy}
                    style={({ pressed }) => [
                      styles.connRow,
                      i > 0 && styles.connBorder,
                      tappable && pressed && styles.connRowPressed,
                    ]}
                  >
                    <View style={styles.logoBox}>
                      <Image
                        source={LOGOS[c.logo]}
                        style={[styles.logo, c.logo === 'gmail.png' && { transform: [{ scale: 1.35 }] }]}
                        resizeMode="contain"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.connTitle}>{c.title}</Text>
                      <Text style={styles.connSub}>{c.sub}</Text>
                    </View>
                    {isBusy ? (
                      <ActivityIndicator color={colors.sageDeep} />
                    ) : c.status === 'disconnected' ? (
                      <View style={styles.connectPill}>
                        <Text style={styles.connectPillText}>Forbind →</Text>
                      </View>
                    ) : (
                      <View style={[styles.statusPill, pillStyle]}>
                        <Text style={[styles.statusText, textStyle]}>{STATUS_LABEL[c.status]}</Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </Animated.View>

            <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
              <Text style={styles.sectionTitle}>Abonnement</Text>
              <View style={styles.inkRule} />
              {subscription ? (
                <View style={styles.planRow}>
                  <Text style={styles.planPrice}>
                    {subscription.priceKr}
                    <Text style={styles.planUnit}> kr/md</Text>
                  </Text>
                  <Text style={styles.planMeta}>{`${subscription.plan} · fornyes ${subscription.renewalDate}`}</Text>
                </View>
              ) : (
                <Text style={styles.emptyText}>Ingen aktiv plan.</Text>
              )}
              <View style={styles.planButtons}>
                <Pressable
                  style={styles.btnInk}
                  onPress={() =>
                    Alert.alert(
                      subscription ? 'Skift plan' : 'Vælg plan',
                      'Abonnementshåndtering er på vej. Kontakt os på Kontakt@zolva.io for at ændre din plan.',
                    )
                  }
                >
                  <Text style={styles.btnInkText}>{subscription ? 'Skift plan' : 'Vælg plan'}</Text>
                </Pressable>
              </View>
            </Animated.View>

            <Animated.View layout={ROW_TRANSITION} style={styles.dark}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
                <Stone mood="thinking" size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.darkTitle}>Privatliv</Text>
                  {/* Copy fact-checked 2026-04-20:
                     - Anthropic retention: workspace does NOT have ZDR, so default
                       up to 30 days T&S retention applies. State that plainly.
                     - Supabase region: eu-west-1 (Ireland) — EU. */}
                  <Text style={styles.darkBody}>
                    Indholdet af dine mails og kalender sendes til Anthropic (Claude) for at lave
                    opsummeringer og udkast. Anthropic kan opbevare data i op til 30 dage til
                    misbrugsovervågning. Dine mails bruges{' '}
                    <Text style={styles.darkStrong}>ikke</Text> til at træne modeller. Konti og
                    tokens hostes i EU hos Supabase.
                  </Text>
                  <View style={{ marginTop: 16, gap: 10 }}>
                    {toggles.map((t) => (
                      <ToggleRow key={t.id} label={t.label} on={t.enabled} onPress={() => flip(t.id)} />
                    ))}
                  </View>
                  {/* Export button removed: a fake Alert is a GDPR liability. Rewire to a real
                      Edge Function (JSON bundle + Resend email) before bringing this back.

                      T3 handoff — please add to legal/privacy-policy-da.md AND
                      legal/privacy-policy-en.md:

                        DA: "For at anmode om en kopi af dine data, skriv til
                             <contact email>. Vi svarer inden for 30 dage jf.
                             GDPR art. 15."
                        EN: "To request a copy of your data, email <contact
                             email>. We respond within 30 days per GDPR Art. 15."

                      Do NOT surface the email in app UI — it belongs in the
                      privacy policy so it stays one authoritative source. */}
                </View>
              </View>
            </Animated.View>

            <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
              <Text style={styles.sectionTitle}>Notifikationer</Text>
              <View style={styles.inkRule} />
              {permission === 'denied' ? (
                <Pressable style={styles.permissionBanner} onPress={() => Linking.openSettings()}>
                  <Text style={styles.permissionBannerText}>
                    Notifikationer er slået fra i systemindstillingerne. Tryk for at åbne.
                  </Text>
                </Pressable>
              ) : null}
              <NotificationToggleRow
                label="Påmindelser"
                value={notificationSettings.reminders}
                onChange={(v) => toggleNotificationSetting('reminders', v)}
              />
              <NotificationToggleRow
                label="Morgenoverblik"
                value={notificationSettings.digest}
                onChange={(v) => toggleNotificationSetting('digest', v)}
              />
              <NotificationToggleRow
                label="Kalender-påmindelse 15 min før"
                value={notificationSettings.preAlerts}
                onChange={(v) => toggleNotificationSetting('preAlerts', v)}
              />
              <NotificationToggleRow
                label="Nye mails"
                value={notificationSettings.newMail}
                onChange={(v) => toggleNotificationSetting('newMail', v)}
              />
            </Animated.View>

            {/* T4: the privacy copy + export-button live above in the dark
                "Privatliv" card. This Konto section is the account-deletion
                entry point; please don't move privacy/export into here. */}
            <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
              <Text style={styles.sectionTitle}>Konto</Text>
              <View style={styles.inkRule} />
              <Pressable
                style={({ pressed }) => [styles.accountRow, pressed && styles.accountRowPressed]}
                onPress={openPrivacyPolicy}
                accessibilityRole="link"
              >
                <Text style={styles.accountRowLabel}>Privatlivspolitik</Text>
                <Text style={styles.accountRowChevron}>→</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.accountRow,
                  styles.accountRowBorder,
                  pressed && styles.accountRowPressed,
                ]}
                onPress={() => setDeleteOpen(true)}
                accessibilityRole="button"
              >
                <Text style={[styles.accountRowLabel, styles.accountRowDestructive]}>
                  Slet konto
                </Text>
                <Text style={[styles.accountRowChevron, styles.accountRowDestructive]}>→</Text>
              </Pressable>
            </Animated.View>

            {user?.email === 'albertfeldt1@gmail.com' && (
              <Pressable
                onPress={async () => {
                  const { data } = await supabase.auth.getSession();
                  const token = data.session?.access_token;
                  if (!token) {
                    Alert.alert('Ikke logget ind', 'Log ind først.');
                    return;
                  }
                  await Clipboard.setStringAsync(token);
                  const minutesLeft = data.session?.expires_at
                    ? Math.round((data.session.expires_at * 1000 - Date.now()) / 60000)
                    : 0;
                  Alert.alert('JWT kopieret', `Udløber om ${minutesLeft} min`);
                }}
                style={{ padding: 16, backgroundColor: '#333', borderRadius: 8, marginTop: 24 }}
              >
                <Text style={{ color: '#fff' }}>Copy JWT (dev)</Text>
              </Pressable>
            )}

            <AnimatedPressable
              layout={ROW_TRANSITION}
              style={styles.signOutRow}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                Alert.alert(
                  'Log ud',
                  'Er du sikker på, at du vil logge ud?',
                  [
                    { text: 'Annullér', style: 'cancel' },
                    {
                      text: 'Log ud',
                      style: 'destructive',
                      onPress: () => {
                        void signOut();
                      },
                    },
                  ],
                );
              }}
            >
              <Text style={styles.signOutText}>Log ud</Text>
            </AnimatedPressable>
          </>
        )}
      </ScrollView>

      <Modal
        visible={deleteOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setDeleteOpen(false)}
      >
        <DeleteAccountScreen
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => setDeleteOpen(false)}
        />
      </Modal>

      <IcloudBriefSheet
        visible={briefSheetOpen}
        onClose={() => setBriefSheetOpen(false)}
        onConnectGmail={() => handleConnect('gmail')}
      />
    </KeyboardAvoidingView>
  );
}

function LoginCard() {
  const { signIn, signUp, signInWithGoogle, signInWithApple, appleAvailable } = useAuth();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<null | 'google' | 'apple'>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async () => {
    if (busy || oauthBusy) return;
    setError(null);
    setInfo(null);
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setError('Udfyld mail og kodeord.');
      return;
    }
    setBusy(true);
    const fn = mode === 'sign-in' ? signIn : signUp;
    const { data, error: err } = await fn(trimmed, password);
    setBusy(false);
    if (err) {
      if (__DEV__) console.warn('[auth] email sign-in failed:', err);
      setError(translateProviderError(err).message);
      return;
    }
    if (mode === 'sign-up' && !data.session) {
      // Supabase returns a fake user with empty identities when the email
      // is already registered (enumeration protection). Detect that and
      // nudge the user toward sign-in instead of telling them to check a
      // mail that will never arrive.
      const identities = data.user?.identities;
      if (Array.isArray(identities) && identities.length === 0) {
        setError('Der findes allerede en konto med den mail. Log ind i stedet.');
        return;
      }
      setInfo('Tjek din mail for at bekræfte din konto.');
    }
  };

  const oauth = async (provider: 'google' | 'apple') => {
    if (busy || oauthBusy) return;
    setError(null);
    setInfo(null);
    setOauthBusy(provider);
    try {
      const { error: err } =
        provider === 'google' ? await signInWithGoogle() : await signInWithApple();
      if (err) {
        if (__DEV__) console.warn(`[auth] ${provider} sign-in returned error:`, err);
        setError(translateProviderError(err).message);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Apple's user-cancel throws ERR_REQUEST_CANCELED — silent ignore
      if (!raw.includes('CANCELED') && !raw.includes('canceled')) {
        if (__DEV__) console.warn(`[auth] ${provider} sign-in threw:`, e);
        setError(translateProviderError(e).message);
      }
    } finally {
      setOauthBusy(null);
    }
  };

  const anyBusy = busy || !!oauthBusy;

  return (
    <View style={styles.loginWrap}>
      <Text style={styles.loginTitle}>
        {mode === 'sign-in' ? 'Log ind' : 'Opret konto'}
      </Text>
      <Text style={styles.loginBody}>
        Forbind dine konti og lad Zolva hjælpe dig med dagen.
      </Text>

      <Pressable
        style={[styles.socialBtn, anyBusy && styles.loginPrimaryBusy]}
        onPress={() => oauth('google')}
        disabled={anyBusy}
      >
        {oauthBusy === 'google' ? (
          <ActivityIndicator color={colors.ink} />
        ) : (
          <>
            <GoogleGlyph />
            <Text style={styles.socialText}>Fortsæt med Google</Text>
          </>
        )}
      </Pressable>

      {appleAvailable && (
        <Pressable
          style={[styles.socialBtnDark, anyBusy && styles.loginPrimaryBusy]}
          onPress={() => oauth('apple')}
          disabled={anyBusy}
        >
          {oauthBusy === 'apple' ? (
            <ActivityIndicator color={colors.paper} />
          ) : (
            <>
              <AppleGlyph />
              <Text style={styles.socialTextDark}>Fortsæt med Apple</Text>
            </>
          )}
        </Pressable>
      )}

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>eller med email</Text>
        <View style={styles.dividerLine} />
      </View>

      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="email@eksempel.dk"
        placeholderTextColor={colors.fg3}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        editable={!anyBusy}
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Kodeord"
        placeholderTextColor={colors.fg3}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="password"
        editable={!anyBusy}
        onSubmitEditing={submit}
        returnKeyType="go"
      />

      {error && <Text style={styles.loginError}>{error}</Text>}
      {info && <Text style={styles.loginInfo}>{info}</Text>}

      <Pressable
        style={[styles.loginPrimary, anyBusy && styles.loginPrimaryBusy]}
        onPress={submit}
        disabled={anyBusy}
      >
        {busy ? (
          <ActivityIndicator color={colors.paper} />
        ) : (
          <Text style={styles.loginPrimaryText}>
            {mode === 'sign-in' ? 'Log ind' : 'Opret konto'}
          </Text>
        )}
      </Pressable>

      <Pressable
        style={styles.loginToggle}
        onPress={() => {
          setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
          setError(null);
          setInfo(null);
        }}
        disabled={anyBusy}
      >
        <Text style={styles.loginToggleText}>
          {mode === 'sign-in'
            ? 'Har du ikke en konto? Opret en →'
            : 'Har du allerede en konto? Log ind →'}
        </Text>
      </Pressable>

      {__DEV__ && (
        <Text style={styles.debugHint} selectable>
          OAuth redirect: {makeRedirectUri({ scheme: 'zolva', path: 'auth/callback' })}
        </Text>
      )}
    </View>
  );
}

function GoogleGlyph() {
  return (
    <Image
      source={require('../../assets/logos/google.png')}
      style={styles.googleGlyph}
      resizeMode="contain"
    />
  );
}

function AppleGlyph() {
  return (
    <Image
      source={require('../../assets/logos/apple.png')}
      style={styles.appleGlyph}
      resizeMode="contain"
    />
  );
}

function WorkPreferenceRow({
  pref,
  sub,
  onChange,
}: {
  pref: WorkPreference;
  sub?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  const pick = (value: string) => {
    onChange(value);
    setOpen(false);
  };
  const shown = pref.value ?? 'Sæt op';

  return (
    <Animated.View layout={ROW_TRANSITION} style={styles.workRow}>
      <Pressable
        onPress={toggle}
        style={({ pressed }) => [styles.workHeader, pressed && styles.workHeaderPressed]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.workTitle}>{pref.title}</Text>
          <Text style={styles.workMeta}>{sub ?? pref.meta}</Text>
        </View>
        <Text style={styles.workVal}>
          {shown} {open ? '↑' : '↓'}
        </Text>
      </Pressable>
      {open && (
        <Animated.View
          entering={OPTIONS_ENTER}
          exiting={OPTIONS_EXIT}
          style={styles.workOptions}
        >
          {pref.options.map((opt) => {
            const selected = pref.value === opt;
            return (
              <Pressable
                key={opt}
                onPress={() => pick(opt)}
                style={({ pressed }) => [
                  styles.workOption,
                  selected && styles.workOptionOn,
                  pressed && styles.workOptionPressed,
                ]}
              >
                {selected && (
                  <Check size={13} color={colors.sageDeep} strokeWidth={2.4} />
                )}
                <Text style={[styles.workOptionText, selected && styles.workOptionTextOn]}>
                  {opt}
                </Text>
              </Pressable>
            );
          })}
        </Animated.View>
      )}
    </Animated.View>
  );
}

const TOGGLE_EASING = Easing.bezier(0.22, 1, 0.36, 1);
const TOGGLE_DURATION = 220;
const TOGGLE_THUMB_TRAVEL = 16; // track 38 - padding 4 - thumb 18

function ToggleRow({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const progress = useSharedValue(on ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(on ? 1 : 0, {
      duration: TOGGLE_DURATION,
      easing: TOGGLE_EASING,
    });
  }, [on, progress]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [colors.paperOn20, colors.sage],
    ),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * TOGGLE_THUMB_TRAVEL }],
  }));

  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="switch"
        accessibilityState={{ checked: on }}
        style={({ pressed }) => [styles.toggleTrack, pressed && styles.toggleTrackPressed]}
      >
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.toggleTrackFill, trackStyle]}
          pointerEvents="none"
        />
        <Animated.View style={[styles.toggleThumb, thumbStyle]} />
      </Pressable>
    </View>
  );
}

const NT_THUMB_TRAVEL = 18; // track 46 - padding 6 - thumb 22

function NotificationToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, {
      duration: TOGGLE_DURATION,
      easing: TOGGLE_EASING,
    });
  }, [value, progress]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [colors.mist, colors.sageDeep],
    ),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * NT_THUMB_TRAVEL }],
  }));

  return (
    <Pressable
      style={styles.ntRow}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
    >
      <Text style={styles.ntLabel}>{label}</Text>
      <View style={styles.ntTrack}>
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.ntTrackFill, trackStyle]}
          pointerEvents="none"
        />
        <Animated.View style={[styles.ntThumb, thumbStyle]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, backgroundColor: colors.paper },

  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56,
    paddingBottom: 22,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  eyebrow: {
    fontFamily: fonts.mono, fontSize: 11,
    letterSpacing: 0.88, textTransform: 'uppercase', color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 10,
    fontFamily: fonts.displayItalic,
    fontSize: 36, lineHeight: 40,
    letterSpacing: -1.08, color: colors.ink,
  },

  authLoading: { paddingVertical: 60, alignItems: 'center' },

  loginWrap: {
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 32,
    gap: 10,
  },
  loginTitle: {
    fontFamily: fonts.displayItalic,
    fontSize: 28,
    letterSpacing: -0.84,
    color: colors.ink,
  },
  loginBody: {
    fontFamily: fonts.ui,
    fontSize: 14,
    lineHeight: 20,
    color: colors.fg3,
    marginBottom: 8,
  },
  input: {
    backgroundColor: colors.mist,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontFamily: fonts.ui,
    fontSize: 15,
    color: colors.ink,
  },
  loginError: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.warningInk,
  },
  loginInfo: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.sageDeep,
  },
  loginPrimary: {
    marginTop: 6,
    backgroundColor: colors.ink,
    paddingVertical: 14,
    borderRadius: 999,
    alignItems: 'center',
  },
  loginPrimaryBusy: { opacity: 0.7 },

  socialBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 13,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  socialText: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.ink,
  },
  socialBtnDark: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 13,
    borderRadius: 999,
    backgroundColor: colors.ink,
  },
  socialTextDark: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.paper,
  },
  googleGlyph: {
    width: 18,
    height: 18,
  },
  appleGlyph: {
    width: 15,
    height: 18,
    marginTop: -2,
    tintColor: colors.paper,
  },

  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    marginBottom: 6,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line,
  },
  dividerText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.fg3,
  },
  loginPrimaryText: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.paper,
  },
  loginToggle: { paddingVertical: 10, alignItems: 'center' },
  loginToggleText: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.sageDeep,
  },
  debugHint: {
    marginTop: 12,
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.fg4,
    textAlign: 'center',
  },

  speech: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 24 },
  speechText: {
    fontFamily: fonts.display, fontSize: 20, lineHeight: 26,
    letterSpacing: -0.3, color: colors.ink,
  },

  section: { paddingHorizontal: 20, paddingTop: 24 },
  sectionTitle: { fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.44, color: colors.ink },
  inkRule: { height: 1, backgroundColor: colors.ink, marginTop: 4 },
  emptyText: {
    paddingVertical: 20,
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 13,
    color: colors.fg3,
  },

  workRow: {
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line,
  },
  workHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14,
  },
  workHeaderPressed: { opacity: 0.55 },
  workTitle: { fontFamily: fonts.uiSemi, fontSize: 14.5, color: colors.ink },
  workMeta: { marginTop: 2, fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg3 },
  workVal: { fontFamily: fonts.ui, fontSize: 13, color: colors.sageDeep },
  workOptions: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    paddingBottom: 14,
  },
  workOption: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  workOptionOn: {
    borderColor: colors.sageDeep,
    backgroundColor: colors.sageSoft,
  },
  workOptionPressed: { opacity: 0.6 },
  workOptionText: { fontFamily: fonts.ui, fontSize: 13, color: colors.fg2 },
  workOptionTextOn: { color: colors.sageDeep, fontFamily: fonts.uiSemi },

  // morning-brief row when only iCloud is connected — disabled visual + 'Læs mere' link to the explainer sheet.
  disabledPrefRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line,
    opacity: 0.65,
  },
  linkText: {
    fontFamily: fonts.uiSemi, fontSize: 13,
    color: colors.sageDeep,
    textDecorationLine: 'underline',
  },

  connRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14,
  },
  connBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  connRowPressed: { opacity: 0.55 },
  connectPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.ink,
  },
  connectPillText: {
    fontFamily: fonts.uiSemi,
    fontSize: 11.5,
    color: colors.paper,
  },
  logoBox: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 32, height: 32 },
  connTitle: { fontFamily: fonts.uiSemi, fontSize: 14.5, color: colors.ink },
  connSub: { marginTop: 2, fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg3 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusSage: { backgroundColor: colors.sageSoft },
  statusWarn: { backgroundColor: colors.warningSoft },
  statusNeutral: { backgroundColor: colors.mist },
  statusText: { fontFamily: fonts.uiSemi, fontSize: 11.5 },
  statusTextSage: { color: colors.sageDeep },
  statusTextWarn: { color: colors.warningInk },
  statusTextNeutral: { color: colors.fg3 },

  planRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, paddingVertical: 16 },
  planPrice: {
    fontFamily: fonts.display, fontSize: 48,
    letterSpacing: -1.92, lineHeight: 52, color: colors.ink,
  },
  planUnit: { fontSize: 18, fontFamily: fonts.displayItalic, color: colors.ink },
  planMeta: { flex: 1, fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg3 },
  planButtons: { flexDirection: 'row', gap: 8, paddingBottom: 24 },
  btnInk: {
    backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 999,
  },
  btnInkText: { color: colors.paper, fontFamily: fonts.uiSemi, fontSize: 13 },

  dark: {
    paddingVertical: 28,
    paddingHorizontal: 20,
    paddingBottom: 32,
    backgroundColor: colors.ink,
  },
  darkTitle: {
    fontFamily: fonts.displayItalic, fontSize: 22,
    letterSpacing: -0.33, color: colors.paper, lineHeight: 26,
  },
  darkBody: {
    marginTop: 10,
    fontFamily: fonts.ui, fontSize: 14, lineHeight: 21, color: colors.paperOn75,
  },
  darkStrong: { color: colors.paper, fontFamily: fonts.uiSemi },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toggleLabel: { flex: 1, fontFamily: fonts.ui, fontSize: 13.5, color: 'rgba(246,241,232,0.9)' },
  toggleTrack: {
    width: 38, height: 22, borderRadius: 999, padding: 2,
    flexDirection: 'row', alignItems: 'center',
    overflow: 'hidden',
  },
  toggleTrackFill: { borderRadius: 999 },
  toggleTrackPressed: { opacity: 0.7 },
  toggleThumb: { width: 18, height: 18, borderRadius: 999, backgroundColor: colors.paper },

  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
  },
  accountRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  accountRowPressed: { opacity: 0.55 },
  accountRowLabel: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.ink,
  },
  accountRowChevron: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.fg3,
  },
  accountRowDestructive: { color: colors.danger },

  signOutRow: {
    paddingVertical: 22,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  signOutText: {
    fontFamily: fonts.uiSemi,
    fontSize: 13,
    color: colors.warningInk,
  },

  // Notification toggles (light-background rows, separate from the dark ToggleRow above)
  ntRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: colors.paper,
    borderRadius: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  ntLabel: { fontSize: 15, color: colors.ink, fontFamily: fonts.ui, flex: 1 },
  ntTrack: {
    width: 46,
    height: 28,
    borderRadius: 14,
    padding: 3,
    overflow: 'hidden',
  },
  ntTrackFill: { borderRadius: 14 },
  ntThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.paper,
  },
  permissionBanner: {
    padding: 12,
    backgroundColor: colors.clay,
    borderRadius: 12,
    marginTop: 8,
    marginBottom: 4,
  },
  permissionBannerText: { fontSize: 13, color: colors.paper, fontFamily: fonts.ui },
});
