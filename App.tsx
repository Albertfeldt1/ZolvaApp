import {
  Fraunces_400Regular,
  Fraunces_500Medium,
  Fraunces_600SemiBold,
  useFonts as useFraunces,
} from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_500Medium_Italic,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts as useInter,
} from '@expo-google-fonts/inter';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_600SemiBold,
  useFonts as useJetBrains,
} from '@expo-google-fonts/jetbrains-mono';
import {
  PlayfairDisplay_400Regular_Italic,
  PlayfairDisplay_500Medium_Italic,
  useFonts as usePlayfair,
} from '@expo-google-fonts/playfair-display';
import { useDesignFonts } from './src/design/fonts';
import * as Haptics from 'expo-haptics';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Linking, StyleSheet, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { DURATION } from './src/design/motion';
import { ChromeInsetsContext, PhoneChrome, TabId } from './src/components/PhoneChrome';
import { TabPane } from './src/components/TabPane';
import { GlassHaloLayer } from './src/design/primitives/GlassHaloLayer';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { OfflineBanner } from './src/components/OfflineBanner';
import { StatusBarScrim } from './src/components/StatusBarScrim';
import { CalendarScreen } from './src/screens/CalendarScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { IcloudSetupScreen } from './src/screens/IcloudSetupScreen';
import { MicrosoftAdminConsentScreen } from './src/screens/MicrosoftAdminConsentScreen';
import { InboxDetailScreen } from './src/screens/InboxDetailScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { MemoryScreen } from './src/screens/MemoryScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { SentMailScreen } from './src/screens/SentMailScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TodayScreen } from './src/screens/TodayScreen';
import { runStartupMigrations } from './src/lib/migrations';
import { presentPaywall } from './src/lib/paywall';
import { registerFeedRecorder, registerResponseHandler, syncOnAppForeground } from './src/lib/notifications';
import { initNotificationSettings } from './src/lib/notification-settings';
import { initNotificationFeed, markFeedByPayload } from './src/lib/notification-feed';
import type { InboxMail, NotificationPayload } from './src/lib/types';
import {
  persistOnboardingConnections,
  persistOnboardingPersona,
  flushPendingPersona,
} from './src/lib/onboarding-persist';
import { colors } from './src/theme';
import { ThemeProvider } from './src/design/ThemeProvider';
import { useAuth } from './src/lib/auth';
import { configurePurchases, loginPurchases, logoutPurchases } from './src/lib/purchases';
import {
  shouldShowMemoryConsent,
  markMemoryConsentShown,
  shouldShowOnboardingBackfill,
  markOnboardingBackfillShown,
  shouldShowV2Onboarding,
  markV2OnboardingShown,
  shouldShowV2OnboardingDevice,
  markV2OnboardingShownDevice,
  useMemoryEnabled,
  refreshMemoryEnabledFromServer,
  shouldShowMsReconnectPrompt,
  markMsReconnectPromptShown,
  useStyleSummaryRefresh,
  useIcloudConnected,
} from './src/lib/hooks';
import { MemoryConsentModal } from './src/components/MemoryConsentModal';
import { OnboardingBackfillScreen } from './src/screens/OnboardingBackfillScreen';
import { OnboardingBackfillProgressScreen } from './src/screens/OnboardingBackfillProgressScreen';
import { OnboardingFactReviewScreen } from './src/screens/OnboardingFactReviewScreen';
import { OnboardingFlowScreen } from './src/screens/OnboardingFlowScreen';
import { subscribeBackfillRerun, type BackfillJob } from './src/lib/onboarding-backfill';
import { AuthSheet } from './src/screens/AuthSheet';
import { LoginCtaBar } from './src/components/LoginCtaBar';
import { isDemoUser } from './src/lib/demo';
import { decideOnboardingTrigger } from './src/lib/onboarding-trigger';
import { usePendingProposalCount } from './src/lib/agent-proposals';
import { syncUserProfile } from './src/lib/user-profile';
import { registerPresenceListener } from './src/lib/presence';
import { writeSnapshotFromSources } from './src/lib/widget-bridge';
import { isPapirEnabled, usePapirEnabled } from './src/lib/papir-flag';
import { subscribeAppOverlays } from './src/lib/app-overlay-bridge';
import { PapirRoot } from './src/screens/papir/PapirRoot';
import { requestPapirRoute } from './src/screens/papir/nav';
import { requestHistorySegment } from './src/screens/papir/PapirHistory';

// Bumped on every fix iteration so we can verify in Metro which bundle
// the device is actually running. Logged once at module eval (cold-start
// or JS reload), so the most recent line tells us the live commit.
const APP_BOOT_TAG = 'boot-splash-native-hold-v1';
console.log(`[BOOT] ${APP_BOOT_TAG}`);

// Without expo-splash-screen the native splash vanished as soon as the RN
// root view appeared — before the JS bundle had even loaded — leaving a
// white gap until boot finished. preventAutoHideAsync keeps the ONE native
// splash up through bundle load, font load and the minimum-visible hold, and
// hideAsync then fades it straight into the ready app. No JS mirror image:
// a JS overlay handoff proved fragile (it could be covered mid-boot), and a
// single native splash can't seam or flash by construction.
// All SplashScreen calls are wrapped: an OTA-updated bundle can land on a
// binary that predates the native module, and must degrade to the old
// auto-hide behavior instead of crashing (runtimeVersion is appVersion).
const SPLASH_MIN_VISIBLE_MS = 1600;
const SPLASH_FADE_MS = 400;

try {
  SplashScreen.setOptions({ fade: true, duration: SPLASH_FADE_MS });
  void SplashScreen.preventAutoHideAsync().catch(() => {});
} catch {}

function hideNativeSplash() {
  try {
    void SplashScreen.hideAsync().catch(() => {});
  } catch {}
}

export default function App() {
  const [fraunces] = useFraunces({
    Fraunces_400Regular,
    Fraunces_500Medium,
    Fraunces_600SemiBold,
  });
  const [playfair] = usePlayfair({
    PlayfairDisplay_400Regular_Italic,
    PlayfairDisplay_500Medium_Italic,
  });
  const [inter] = useInter({
    Inter_400Regular,
    Inter_500Medium,
    Inter_500Medium_Italic,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [mono] = useJetBrains({
    JetBrainsMono_400Regular,
    JetBrainsMono_600SemiBold,
  });
  const designFonts = useDesignFonts();

  const { user, initializing: authInitializing, googleAccessToken, microsoftAccessToken, signInWithMicrosoft, disconnectProvider } = useAuth();
  // iCloud mail connectedness (valid app-specific password). The backfill server
  // supports iCloud mail, so an iCloud-only user is a real provider for the
  // Genscan / memory-enable backfill gates below — not a dead-end.
  const icloudConnected = useIcloudConnected(user?.id ?? '');

  // RevenueCat: configure once on mount, then keep the purchases identity in
  // sync with the Supabase auth user (logIn on sign-in, logOut on sign-out).
  useEffect(() => {
    configurePurchases();
  }, []);

  useEffect(() => {
    if (user?.id) void loginPurchases(user.id);
    else void logoutPurchases();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const unsubscribe = registerPresenceListener(() => user?.id ?? null);
    return unsubscribe;
  }, [user?.id]);

  // Fire-and-forget: re-analyze the user's writing style whenever a
  // mail provider connects or the cached summary ages past its TTL.
  // Hook is internally TTL-gated so this is essentially free on warm
  // launches and only does real work on the first connect of each
  // provider (or every 14 days thereafter).
  useStyleSummaryRefresh();
  const pendingProposalCount = usePendingProposalCount(user?.id);

  const [tab, setTab] = useState<TabId>('today');
  // Tracks the last non-Settings tab so the Settings back button can return
  // the user to whichever tab they came from (Today, Inbox, Calendar, Husk).
  const [previousTab, setPreviousTab] = useState<Exclude<TabId, 'settings'>>('today');
  // Tabs mount on first visit and stay mounted thereafter. Keeping screens
  // alive preserves state, scroll, and fetched data - switching tabs becomes
  // an instant crossfade instead of a remount + refetch.
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(() => new Set([tab]));
  useEffect(() => {
    setMountedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, [tab]);

  // No force-to-Settings on logout. Apple 5.1.1 rejects apps that open
  // straight to a login wall on cold launch, so the entry surface has to
  // stay browseable when the user isn't signed in. The bottom nav stays
  // visible (chrome no longer hides on !user), so Settings is reachable
  // for re-login without forcing the user there.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState<string | undefined>(undefined);
  // When true, ChatScreen fires send() once on mount with the prefilled
  // draft. Used by observation CTAs ("Accepter invitation", "Gennemgå
  // sikkerhed") so tapping them performs the action instead of just
  // dropping the user into a chat with text waiting for a second tap.
  const [chatAutoSend, setChatAutoSend] = useState(false);
  const [openMail, setOpenMail] = useState<InboxMail | null>(null);
  // When true, InboxDetailScreen kicks off the draft-reply generator on
  // mount so observations with action `mailDraft` open a fully-prepared
  // editor instead of an empty one. Cleared on close.
  const [openMailAutoDraft, setOpenMailAutoDraft] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [sentMailsOpen, setSentMailsOpen] = useState(false);
  const [icloudSetupOpen, setIcloudSetupOpen] = useState(false);
  const [icloudPrefilledEmail, setIcloudPrefilledEmail] = useState<string | undefined>(undefined);
  const [adminConsentOpen, setAdminConsentOpen] = useState(false);
  const [adminConsentPrefilledEmail, setAdminConsentPrefilledEmail] = useState<string | undefined>(undefined);
  const [authSheetOpen, setAuthSheetOpen] = useState(false);
  // Bumped on overlay close so SettingsScreen's iCloud loadCredential effect re-runs.
  const [icloudRefreshVersion, setIcloudRefreshVersion] = useState(0);
  const [chromeOverDark, setChromeOverDark] = useState(false);
  const [chromeHeight, setChromeHeight] = useState(0);
  const [ctaBarHeight, setCtaBarHeight] = useState(0);
  const [migrationsDone, setMigrationsDone] = useState(false);
  const [memoryConsentOpen, setMemoryConsentOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // 'v2-intro' is the default first-time stage; the trigger effect below
  // opens V2 for new users, and the legacy chain ('intro' / 'progress' /
  // 'review') is reached either via V2's onComplete or the Memory-tab
  // "Genscan" rerun path.
  const [onboardingStage, setOnboardingStage] = useState<'v2-intro' | 'intro' | 'progress' | 'review'>('v2-intro');
  const [onboardingForceRerun, setOnboardingForceRerun] = useState(false);
  const [onboardingFailedJobs, setOnboardingFailedJobs] = useState<BackfillJob[]>([]);
  // Set whenever a 'brief' push or in-app notification row is tapped, or a
  // zolva://today#brief deep link arrives. TodayScreen opens the matching
  // brief modal on each nonce change. briefId may be missing for deep links
  // that don't reference a specific brief - the screen falls back to today's
  // cached brief in that case.
  const [briefOpenRequest, setBriefOpenRequest] = useState<{ nonce: number; briefId?: string }>({ nonce: 0 });
  const requestBriefOpen = (briefId?: string) =>
    setBriefOpenRequest((prev) => ({ nonce: prev.nonce + 1, briefId }));

  // Suppress the consent modal while V2 onboarding is on-screen — otherwise
  // OAuth completing during step 6 (Trust) pops the modal over the flow and
  // the user gets bombarded before they reach step 7. After V2 finishes
  // (stage flips off 'v2-intro') the gate releases and consent re-evaluates.
  // The inner `shouldShowV2Onboarding` check covers the race window after
  // sign-in where the V2 trigger hasn't yet flipped onboardingOpen — without
  // it, consent can pop before V2 has a chance to open.
  const inV2Onboarding = onboardingOpen && onboardingStage === 'v2-intro';
  useEffect(() => {
    const uid = user?.id;
    if (!uid) return;
    if (inV2Onboarding) return;
    let cancelled = false;
    void shouldShowV2Onboarding(uid).then((v2Pending) => {
      // I Papir kører ingen V2-wizard, så et evigt-pending V2-flag må ikke
      // blokere memory-consent (den ville ellers aldrig vises for nye brugere).
      if (cancelled || (v2Pending && !isPapirEnabled())) return;
      void shouldShowMemoryConsent(uid).then((show) => {
        if (cancelled || !show) return;
        setMemoryConsentOpen(true);
      });
    });
    return () => { cancelled = true; };
  }, [user?.id, inV2Onboarding]);

  // Open the V2 onboarding wizard on the sign-in transition (NOT on cold
  // launch). Logged-out cold launches land in the empty app behind the
  // login CTA; the wizard only appears once the user authenticates. Reuses
  // the existing device + per-uid gates via decideOnboardingTrigger.
  useEffect(() => {
    if (authInitializing) return;
    if (onboardingOpen) return;
    // Produktbeslutning 2026-07-09: Papir kører UDEN onboarding-wizard.
    // Udvidet 2026-07-12: wizarden er slået fra i BEGGE UI'er — login skal
    // lande direkte i appen (Rikkes test: wizardens forbind-trin viste
    // Google-kilder som frakoblet lige efter et fuldt Google-login).
    // Backfill dækkes af Genscan i Settings (subscribeBackfillRerun
    // nedenfor), som fortsat må åbne kædens intro/progress/review-stadier.
    // Flip flaget for at genaktivere wizarden.
    const V2_WIZARD_ENABLED = false as boolean;
    if (!V2_WIZARD_ENABLED || isPapirEnabled()) return;
    const uid = user?.id;
    if (!uid) return;
    let cancelled = false;
    void (async () => {
      const [deviceShowPending, uidShowPending] = await Promise.all([
        shouldShowV2OnboardingDevice(),
        shouldShowV2Onboarding(uid),
      ]);
      if (cancelled) return;
      const decision = decideOnboardingTrigger({
        isDemo: isDemoUser(user),
        deviceShowPending,
        uidShowPending,
      });
      if (decision === 'mark-device-shown') {
        await markV2OnboardingShownDevice();
        return;
      }
      if (decision !== 'open') return;
      setOnboardingStage('v2-intro');
      setOnboardingOpen(true);
    })();
    return () => { cancelled = true; };
  }, [user?.id, user, authInitializing, onboardingOpen]);

  // Flush any onboarding persona stashed before user.id was set. The race:
  // user does Google/Microsoft OAuth in step 6, taps through to finish, and
  // onComplete fires faster than useAuth broadcasts the new user. Without
  // this the persona answers (autonomy/tone/morning-brief) would silently
  // not land in work_preferences and Settings would show defaults.
  useEffect(() => {
    const uid = user?.id;
    if (!uid) return;
    void flushPendingPersona(uid);
  }, [user?.id]);

  // Listen for explicit re-run triggers from MemoryScreen's "Genscan" button
  // and reopen the chain in force-rerun mode (Start passes force:true so the
  // edge function clears the prior backfill_jobs and runs fresh).
  useEffect(() => {
    return subscribeBackfillRerun(() => {
      if (!user?.id) return;
      const hasProvider = !!googleAccessToken || !!microsoftAccessToken || icloudConnected;
      if (!hasProvider) return;
      setOnboardingForceRerun(true);
      setOnboardingStage('intro');
      setOnboardingOpen(true);
    });
  }, [user?.id, googleAccessToken, microsoftAccessToken, icloudConnected]);

  // Open the onboarding-backfill chain whenever memory-enabled flips false → true,
  // regardless of which UI surface flipped it (MemoryConsentModal, MemoryScreen
  // toggle, etc). Gate on having a Google/Microsoft provider connected - Apple
  // -only sign-in lands on the empty "no accounts" state, which is a dead-end.
  const memoryEnabled = useMemoryEnabled();
  const prevMemoryEnabled = useRef(memoryEnabled);
  useEffect(() => {
    const uid = user?.id;
    const transitionedOn = memoryEnabled && !prevMemoryEnabled.current;
    prevMemoryEnabled.current = memoryEnabled;
    if (!uid || !transitionedOn) return;
    const hasProvider = !!googleAccessToken || !!microsoftAccessToken || icloudConnected;
    if (!hasProvider) return;
    // Don't override the V2 stage — V2's onComplete handler advances to
    // 'intro' on its own when the user finishes the flow.
    if (inV2Onboarding) return;
    let cancelled = false;
    void shouldShowOnboardingBackfill(uid).then((show) => {
      if (cancelled || !show) return;
      setOnboardingStage('intro');
      setOnboardingOpen(true);
    });
    return () => { cancelled = true; };
  }, [memoryEnabled, user?.id, googleAccessToken, microsoftAccessToken, icloudConnected, inV2Onboarding]);

  // What's-new modal disabled — was firing on every login during onboarding
  // iteration and adding noise. Re-enable later if there's a release we
  // actually want to announce in-app.

  // One-shot Microsoft reconnect nudge - old tokens carry Calendars.Read,
  // new code requires Calendars.ReadWrite for chatbot/voice calendar writes.
  useEffect(() => {
    const uid = user?.id;
    if (!uid || isDemoUser(user) || !microsoftAccessToken) return;
    let cancelled = false;
    void shouldShowMsReconnectPrompt(uid).then((show) => {
      if (cancelled || !show) return;
      Alert.alert(
        'Genforbind Microsoft',
        'Vi har udvidet Microsoft-tilladelserne, så Zolva kan oprette og redigere møder for dig. Genforbind din Microsoft-konto for at aktivere det.',
        [
          {
            text: 'Senere',
            style: 'cancel',
            onPress: () => { void markMsReconnectPromptShown(uid); },
          },
          {
            text: 'Genforbind',
            onPress: async () => {
              await markMsReconnectPromptShown(uid);
              try {
                await disconnectProvider('microsoft');
                await signInWithMicrosoft();
              } catch (err) {
                if (__DEV__) console.warn('[ms-reconnect] failed:', err);
              }
            },
          },
        ],
      );
    });
    return () => { cancelled = true; };
  }, [user?.id, microsoftAccessToken, disconnectProvider, signInWithMicrosoft, user]);

  useEffect(() => {
    if (!user?.id || isDemoUser(user)) return;
    syncUserProfile(user.id);
    // Pull the server-side memory_enabled gate so this device converges
    // to whatever was last set on any device. Rate-limited internally,
    // safe to call eagerly on every auth resolve.
    void refreshMemoryEnabledFromServer();
  }, [user?.id]);

  // Gate render on migrations. Screens read legacy AsyncStorage keys during
  // mount - if a previous user's data hasn't been purged yet, it would leak
  // into the new session before the migration finishes.
  useEffect(() => {
    let cancelled = false;
    runStartupMigrations().finally(() => {
      if (!cancelled) setMigrationsDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!migrationsDone) return;
    initNotificationSettings();
    initNotificationFeed();
    // Record every delivered notification into the in-app feed (received +
    // tapped), so the Notifications screen is an actual history.
    const unsubFeedRecorder = registerFeedRecorder();
    let inflight: Promise<void> | null = null;
    const runSync = () => {
      if (inflight) return;
      inflight = syncOnAppForeground().finally(() => {
        inflight = null;
      });
    };
    runSync();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        runSync();
        // Re-pull the server-side memory_enabled gate; internal 5-min
        // throttle bounds chattiness from frequent foreground bounces.
        void refreshMemoryEnabledFromServer();
        // Refresh widget on foreground (debounced inside writeSnapshot)
        void writeSnapshotFromSources({});
      }
    });
    return () => {
      sub.remove();
      unsubFeedRecorder();
    };
  }, [migrationsDone]);

  useEffect(() => {
    if (!chatOpen) {
      setChatDraft(undefined);
      setChatAutoSend(false);
    }
  }, [chatOpen]);

  // Keep `previousTab` in sync with `tab` whenever the user lands on any
  // non-Settings tab. Captures changes from every code path (switchTab,
  // notification response handler, deep links) without needing each call
  // site to remember to update it. When tab flips to 'settings',
  // previousTab is left alone - that's the value the back button reads.
  useEffect(() => {
    if (tab !== 'settings') setPreviousTab(tab);
  }, [tab]);

  useEffect(() => {
    const unsub = registerResponseHandler((payload) => {
      setChatOpen(false);
      setOpenMail(null);
      setNotificationsOpen(false);
      setIcloudSetupOpen(false);
      setAdminConsentOpen(false);
      void markFeedByPayload(payload);
      // Papir har sin egen navigation — oversæt til en Papir-rute i stedet
      // for at flytte klassiske tabs, som er usynlige når Papir er aktiv.
      // Mapping matcher PapirNotifications' destinationFor.
      if (isPapirEnabled()) {
        switch (payload.type) {
          case 'reminder':
          case 'digest':
          case 'reminderAdded':
          case 'calendarPreAlert':
            requestPapirRoute({ kind: 'tab', tab: 'plan' });
            break;
          case 'brief':
            requestPapirRoute({ kind: 'push', screen: 'briefing' });
            break;
          case 'newMail':
            requestPapirRoute({ kind: 'push', screen: 'inbox' });
            break;
          case 'factDecay':
            requestHistorySegment(2); // Fakta
            requestPapirRoute({ kind: 'tab', tab: 'history' });
            break;
          case 'chatReply':
            requestPapirRoute({ kind: 'push', screen: 'chat' });
            break;
          case 'agent_proposal':
            requestPapirRoute({ kind: 'push', screen: 'agent' });
            break;
          case 'microsoftConsentGranted':
            requestPapirRoute({ kind: 'push', screen: 'settings' });
            break;
          case 'trialEnding':
            void presentPaywall();
            break;
        }
        return;
      }
      switch (payload.type) {
        case 'reminder':
        case 'digest':
        case 'reminderAdded':
          setTab('today');
          break;
        case 'brief':
          setTab('today');
          requestBriefOpen(payload.briefId);
          break;
        case 'calendarPreAlert':
          setTab('calendar');
          break;
        case 'newMail':
          setTab('inbox');
          break;
        case 'factDecay':
          // Decaying-fact heads-up routes to Memory so the user can confirm,
          // edit, or let the fact go.
          setTab('memory');
          break;
        case 'microsoftConsentGranted':
          // Admin granted the request - bring the user back to Settings so
          // they can finally tap "Connect Outlook" and proceed.
          setTab('settings');
          break;
        case 'chatReply':
          // Backgrounded chat turn finished. The default setChatOpen(false)
          // above batches with this true into a single render, so the chat
          // surface opens cleanly. useChat reconciles the resolved job on
          // mount/foreground and renders the assistant message - no need
          // to forward the jobId here.
          setChatOpen(true);
          break;
        case 'agent_proposal':
          // Autonomous agent proposed an action. Route to Today so the
          // proposal card is visible for the user to approve or dismiss.
          setTab('today');
          break;
        case 'trialEnding':
          // Trial ends in 2 days. Open the paywall so the user can convert.
          void presentPaywall();
          break;
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      // Papir-rute for deep links — samme oversættelse som notifikationstryk.
      if (isPapirEnabled()) {
        if (url.startsWith('zolva://chat')) {
          requestPapirRoute({ kind: 'push', screen: 'chat' });
        } else if (url.startsWith('zolva://today')) {
          if (url.includes('#brief')) requestPapirRoute({ kind: 'push', screen: 'briefing' });
          else requestPapirRoute({ kind: 'tab', tab: 'home' });
        } else if (url.startsWith('zolva://calendar/event/')) {
          requestPapirRoute({ kind: 'tab', tab: 'plan' });
        } else if (url.startsWith('zolva://settings')) {
          requestPapirRoute({ kind: 'push', screen: 'settings' });
        }
        return;
      }
      if (url.startsWith('zolva://chat')) {
        setChatOpen(true);
        return;
      }
      if (url.startsWith('zolva://today')) {
        setTab('today');
        // open the brief modal if the URL includes #brief
        if (url.includes('#brief')) requestBriefOpen();
        return;
      }
      if (url.startsWith('zolva://calendar/event/')) {
        setTab('calendar');
        // event-detail open is handled by CalendarScreen via the URL - left as a
        // follow-up. v1: tapping a meeting nudge lands the user on the calendar
        // tab focused on the right day.
        return;
      }
      if (url.startsWith('zolva://settings')) {
        setTab('settings');
        // Anchor (e.g. #calendars from voice oauthInvalid response) is read
        // by SettingsScreen via the URL - left as a follow-up. v2: landing
        // the user on the Settings tab is enough to unblock label setup or
        // provider reconnect after a voice-action snippet tap.
        return;
      }
    };

    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, []);

  // Papir screens request App-level overlays (iCloud setup / MS admin
  // consent) via the module bridge — they can't be prop-drilled through
  // PapirShell. Must live ABOVE the font-gate early-return with the other
  // boot hooks; state setters are stable so subscribing once is safe.
  useEffect(() => {
    return subscribeAppOverlays((req) => {
      Haptics.selectionAsync();
      if (req.kind === 'icloud-setup') {
        setIcloudPrefilledEmail(req.prefilledEmail);
        setIcloudSetupOpen(true);
      } else {
        setAdminConsentPrefilledEmail(req.prefilledEmail);
        setAdminConsentOpen(true);
      }
    });
  }, []);

  // Computed early so the chrome-inset memo can account for the login CTA bar.
  const loggedOut = !authInitializing && !user;

  // Dev-only Papir toggle (always false in release builds). Declared with the
  // other hooks so the early return below stays hook-safe.
  const papirEnabled = usePapirEnabled();

  // Keep the native splash up for a minimum time once the app is ready, so
  // the logo doesn't blink away after half a second on fast launches. The
  // minimum counts from App's first render; native init before that only
  // adds visible logo time.
  const bootAtRef = useRef(Date.now());
  const [splashDone, setSplashDone] = useState(false);
  const bootReady = !!(fraunces && playfair && inter && mono && designFonts && migrationsDone);
  useEffect(() => {
    if (!bootReady || splashDone) return;
    const elapsed = Date.now() - bootAtRef.current;
    const t = setTimeout(() => {
      setSplashDone(true);
      hideNativeSplash();
    }, Math.max(0, SPLASH_MIN_VISIBLE_MS - elapsed));
    return () => clearTimeout(t);
  }, [bootReady, splashDone]);

  // Shadow from the tab bar bleeds a few pixels above its measured box;
  // a small buffer keeps the last line of content clear of it. When logged
  // out, the persistent login CTA bar sits above the tab chrome, so content
  // must clear both — add the CTA bar's measured height too.
  const chromeInsets = useMemo(() => {
    if (chromeHeight <= 0) return { bottom: 0 };
    const ctaClearance = loggedOut && ctaBarHeight > 0 ? ctaBarHeight : 0;
    return { bottom: chromeHeight + 12 + ctaClearance };
  }, [chromeHeight, loggedOut, ctaBarHeight]);

  if (!bootReady) {
    // The native splash (preventAutoHideAsync) covers this while fonts load;
    // the paper backdrop only shows on binaries without the splash module
    // (pre-module OTA targets), where the splash auto-hides early.
    return <View style={[styles.root, { backgroundColor: '#FBFAF6' }]} />;
  }

  // NOTE: the Papir early-return lives further down (after the modal
  // handlers) so it can render the SAME session overlays — onboarding,
  // memory consent, iCloud setup, admin consent — as the classic path (K1).

  // Logged-out tracking is only used for downstream UX hints now (e.g. the
  // Today screen's "log ind for at se dine ting" banner). The bottom nav
  // stays visible so Settings is reachable for re-login, and the cold-launch
  // surface isn't a login wall - Apple 5.1.1 rejects that. (`loggedOut` is
  // declared above so the chrome-inset memo can include the login CTA bar.)

  const openChat = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setChatDraft(undefined);
    setChatOpen(true);
  };

  const openChatWithPrompt = (prompt: string, opts?: { autoSend?: boolean }) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setChatDraft(prompt);
    setChatAutoSend(opts?.autoSend === true);
    setChatOpen(true);
  };

  const closeChat = () => {
    Haptics.selectionAsync();
    setChatOpen(false);
    setChatDraft(undefined);
  };

  const switchTab = (t: TabId) => {
    if (t !== tab || chatOpen) {
      Haptics.selectionAsync();
    }
    setTab(t);
    setChatOpen(false);
    setOpenMail(null);
    setNotificationsOpen(false);
    setIcloudSetupOpen(false);
    setAdminConsentOpen(false);
    // Reset to light chrome on every tab switch. The active tab's screen will
    // re-publish dark via its isActive effect if its scroll position warrants.
    setChromeOverDark(false);
  };

  const openNotifications = () => {
    Haptics.selectionAsync();
    setNotificationsOpen(true);
  };

  const closeNotifications = () => {
    Haptics.selectionAsync();
    setNotificationsOpen(false);
  };

  const openIcloudSetup = (prefilledEmail?: string) => {
    Haptics.selectionAsync();
    setIcloudPrefilledEmail(prefilledEmail);
    setIcloudSetupOpen(true);
  };

  const closeIcloudSetup = () => {
    Haptics.selectionAsync();
    setIcloudSetupOpen(false);
    setIcloudPrefilledEmail(undefined);
    setIcloudRefreshVersion((v) => v + 1);
  };

  const openAdminConsent = (prefilledEmail?: string) => {
    Haptics.selectionAsync();
    setAdminConsentPrefilledEmail(prefilledEmail);
    setAdminConsentOpen(true);
  };

  const closeAdminConsent = () => {
    Haptics.selectionAsync();
    setAdminConsentOpen(false);
    setAdminConsentPrefilledEmail(undefined);
  };

  const openAuthSheet = () => {
    Haptics.selectionAsync();
    setAuthSheetOpen(true);
  };
  const closeAuthSheet = () => setAuthSheetOpen(false);

  // Logged-out taps that need an account open the sign-in sheet instead of
  // running the action. Demo users count as authed and pass through.
  const requireAuth = (action: () => void) => {
    if (loggedOut) {
      openAuthSheet();
      return;
    }
    action();
  };

  const handleNotificationNavigate = (payload: NotificationPayload) => {
    setNotificationsOpen(false);
    setChatOpen(false);
    setOpenMail(null);
    setIcloudSetupOpen(false);
    setAdminConsentOpen(false);
    switch (payload.type) {
      case 'reminder':
      case 'digest':
      case 'reminderAdded':
        setTab('today');
        break;
      case 'brief':
        setTab('today');
        requestBriefOpen(payload.briefId);
        break;
      case 'calendarPreAlert':
        setTab('calendar');
        break;
      case 'newMail':
        setTab('inbox');
        break;
      case 'factDecay':
        setTab('memory');
        break;
      case 'microsoftConsentGranted':
        setTab('settings');
        break;
      case 'chatReply':
        setChatOpen(true);
        break;
      case 'agent_proposal':
        // Autonomous agent proposed an action. Route to Today so the
        // proposal card is visible for the user to approve or dismiss.
        setTab('today');
        break;
      case 'trialEnding':
        // Trial ends in 2 days. Open the paywall so the user can convert.
        void presentPaywall();
        break;
    }
  };

  const openMailDetail = (m: InboxMail, opts?: { autoDraft?: boolean }) => {
    Haptics.selectionAsync();
    setOpenMail(m);
    setOpenMailAutoDraft(!!opts?.autoDraft);
  };

  const closeMailDetail = () => {
    Haptics.selectionAsync();
    setOpenMail(null);
    setOpenMailAutoDraft(false);
  };

  // Session overlays shared by BOTH UIs (K1): onboarding chain, iCloud
  // setup, Microsoft admin consent, auth sheet and the memory-consent modal.
  // In Papir mode the classic-only gates (chatOpen, openMail, …) are always
  // false, so the conditions reduce to the overlay's own open-state.
  const sessionOverlays = (
    <>
      {icloudSetupOpen && !chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && (
        <Animated.View
          key="icloud-setup"
          style={StyleSheet.absoluteFill}
          entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
          exiting={SlideOutDown.duration(DURATION.modalExit)}
        >
          <IcloudSetupScreen
            prefilledEmail={icloudPrefilledEmail}
            onDone={closeIcloudSetup}
            onCancel={closeIcloudSetup}
          />
        </Animated.View>
      )}
      {adminConsentOpen && !chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && !icloudSetupOpen && (
        <Animated.View
          key="admin-consent"
          style={StyleSheet.absoluteFill}
          entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
          exiting={SlideOutDown.duration(DURATION.modalExit)}
        >
          <MicrosoftAdminConsentScreen
            prefilledEmail={adminConsentPrefilledEmail}
            onCancel={closeAdminConsent}
          />
        </Animated.View>
      )}
      {authSheetOpen && loggedOut && !chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && !icloudSetupOpen && !adminConsentOpen && !onboardingOpen && (
        <Animated.View
          key="auth-sheet"
          style={StyleSheet.absoluteFill}
          entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
          exiting={SlideOutDown.duration(DURATION.modalExit)}
        >
          <AuthSheet onClose={closeAuthSheet} />
        </Animated.View>
      )}
      {/* V2 onboarding stage doesn't require auth — it's pure UI iteration.
          Later stages (intro/progress/review) reference user.id, so they
          stay gated on `user` being present. */}
      {onboardingOpen && !chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && !icloudSetupOpen && !adminConsentOpen && (
        <Animated.View
          key="onboarding-backfill"
          style={StyleSheet.absoluteFill}
          entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
          exiting={SlideOutDown.duration(DURATION.modalExit)}
        >
          {onboardingStage === 'v2-intro' && (
            <OnboardingFlowScreen
              onOpenIcloudSetup={() => openIcloudSetup()}
              onComplete={(collected) => {
                if (__DEV__) {
                  console.log('[onboarding-flow] collected state:', JSON.stringify(collected, null, 2));
                }
                // Mark V2 shown the moment the user finishes the flow so
                // a mid-backfill app close doesn't replay the 7 steps on
                // next launch — they'll resume the legacy chain via the
                // Memory tab → Genscan path instead. Device flag persists
                // across logout so cold launches stay non-login-wall.
                if (user?.id) void markV2OnboardingShown(user.id);
                void markV2OnboardingShownDevice();
                // Persist onboarding selections. Connections fire eagerly
                // (device-level, no uid needed) - that's what was getting
                // lost when user.id hadn't propagated from a fresh
                // mid-onboarding OAuth sign-in. Persona needs a uid so we
                // hand it null-tolerantly: if user.id is set, write
                // through; if not, stash and flushPendingPersona below
                // picks it up once auth state catches up.
                void persistOnboardingConnections({
                  persona: collected.persona,
                  connections: collected.connections,
                });
                void persistOnboardingPersona(user?.id ?? null, collected.persona);
                // Auth precedes the wizard now, so user.id is always set
                // here — advance straight into the backfill chain.
                setOnboardingStage('intro');
              }}
            />
          )}
          {user?.id && onboardingStage === 'intro' && (
            <OnboardingBackfillScreen
              forceRerun={onboardingForceRerun}
              onStart={() => {
                setOnboardingFailedJobs([]);
                setOnboardingStage('progress');
              }}
              onSkip={() => {
                const uid = user.id;
                void markOnboardingBackfillShown(uid);
                setOnboardingOpen(false);
                setOnboardingForceRerun(false);
              }}
              onConnectMore={() => {
                // Mark as shown so the chain doesn't reopen on next launch -
                // user is intentionally deferring. They'll re-trigger via
                // Memory tab → Genscan once they're done connecting accounts.
                const uid = user.id;
                void markOnboardingBackfillShown(uid);
                setOnboardingOpen(false);
                setOnboardingForceRerun(false);
                switchTab('settings');
              }}
            />
          )}
          {user?.id && onboardingStage === 'progress' && (
            <OnboardingBackfillProgressScreen
              onComplete={(failed) => {
                setOnboardingFailedJobs(failed);
                setOnboardingStage('review');
              }}
            />
          )}
          {user?.id && onboardingStage === 'review' && (
            <OnboardingFactReviewScreen
              failedJobs={onboardingFailedJobs}
              onDone={() => {
                const uid = user.id;
                void markOnboardingBackfillShown(uid);
                setOnboardingOpen(false);
                setOnboardingForceRerun(false);
                setOnboardingFailedJobs([]);
              }}
            />
          )}
        </Animated.View>
      )}
    </>
  );

  const memoryConsentModal = user?.id ? (
    <MemoryConsentModal
      visible={memoryConsentOpen}
      userId={user.id}
      onClose={() => {
        const uid = user.id;
        setMemoryConsentOpen(false);
        void markMemoryConsentShown(uid);
        // The chain trigger now lives in the memory-enabled transition
        // watcher above - it fires regardless of which UI surface flipped
        // memory ON, so we don't need to fire it again here.
      }}
    />
  ) : null;

  // Papir UI (dev toggle): a different face on the same running app. Every
  // boot effect above (auth, RevenueCat, push, deep links, widget snapshot)
  // keeps running — only the rendered chrome changes, and the session
  // overlays above render on top of Papir exactly as they do on classic.
  if (papirEnabled) {
    return (
      <ThemeProvider>
        <ErrorBoundary>
          <View style={{ flex: 1 }}>
            <PapirRoot loggedOut={loggedOut} />
            {sessionOverlays}
            {memoryConsentModal}
          </View>
        </ErrorBoundary>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
    <ErrorBoundary>
    <ChromeInsetsContext.Provider value={chromeInsets}>
    <View style={styles.root}>
      <StatusBar style="dark" translucent />
      <OfflineBanner />
      <View style={styles.content}>
        {/* App-level airbrushy backdrop sits underneath all TabPanes. Each
            screen renders its own GlassHaloLayer on top when fully
            visible, but during a tab crossfade - when both panes are at
            partial opacity - this base layer shows through so the
            "behind" surface matches the airbrushy wash instead of
            flashing the bare paper background. */}
        <GlassHaloLayer />
        <TabPane active={tab === 'today' }>
          {mountedTabs.has('today') && (
            <TodayScreen
              onOpenChat={openChat}
              onOpenChatWithPrompt={openChatWithPrompt}
              onOpenMail={openMailDetail}
              onGoToSettings={() => switchTab('settings')}
              onGoToMemory={() => switchTab('memory')}
              onGoToCalendar={() => switchTab('calendar')}
              onGoToInbox={() => switchTab('inbox')}
              onOpenNotifications={openNotifications}
              onOverDarkChange={setChromeOverDark}
              briefOpenRequest={briefOpenRequest}
              onOpenIcloudSetup={openIcloudSetup}
              isActive={tab === 'today'}
            />
          )}
        </TabPane>
        <TabPane active={tab === 'inbox' }>
          {mountedTabs.has('inbox') && (
            <InboxScreen
              onGoToSettings={() => switchTab('settings')}
              onOpenMail={openMailDetail}
              onOverDarkChange={setChromeOverDark}
              onOpenIcloudSetup={openIcloudSetup}
              onOpenNotifications={openNotifications}
              onOpenSentMails={() => setSentMailsOpen(true)}
              isActive={tab === 'inbox'}
            />
          )}
        </TabPane>
        <TabPane active={tab === 'calendar' }>
          {mountedTabs.has('calendar') && (
            <CalendarScreen
              onGoToSettings={() => switchTab('settings')}
              onOpenNotifications={openNotifications}
            />
          )}
        </TabPane>
        <TabPane active={tab === 'memory' }>
          {mountedTabs.has('memory') && (
            <MemoryScreen
              onOpenChat={openChat}
              onOpenNotifications={openNotifications}
              onOpenSettings={() => switchTab('settings')}
            />
          )}
        </TabPane>
        <TabPane active={tab === 'settings' }>
          {mountedTabs.has('settings') && (
            <SettingsScreen
              onOpenIcloudSetup={openIcloudSetup}
              onOpenMicrosoftAdminConsent={openAdminConsent}
              icloudRefreshVersion={icloudRefreshVersion}
              onOpenNotifications={openNotifications}
              onBack={() => switchTab(previousTab)}
            />
          )}
        </TabPane>
        {chatOpen && (
          <Animated.View
            key="chat"
            // Paint the paper colour onto the overlay itself so when
            // KeyboardAvoidingView (inside ChatScreen) adds bottom
            // padding equal to the keyboard height, the resulting gap
            // doesn't reveal the screen tree underneath. Without this,
            // the chat looks like it sits ON TOP of the previous tab
            // and gets pushed up by the keyboard with the old screen
            // peeking through underneath.
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.paper }]}
            entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
            exiting={SlideOutDown.duration(DURATION.modalExit)}
          >
            <ChatScreen onBack={closeChat} initialDraft={chatDraft} initialDraftAutoSend={chatAutoSend} />
          </Animated.View>
        )}
        {openMail && !chatOpen && (
          <Animated.View
            key={`mail-${openMail.id}`}
            style={StyleSheet.absoluteFill}
            entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
            exiting={SlideOutDown.duration(DURATION.modalExit)}
          >
            <InboxDetailScreen mail={openMail} onClose={closeMailDetail} autoDraft={openMailAutoDraft} />
          </Animated.View>
        )}
        {notificationsOpen && !chatOpen && !openMail && (
          <Animated.View
            key="notifications"
            style={StyleSheet.absoluteFill}
            entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
            exiting={SlideOutDown.duration(DURATION.modalExit)}
          >
            <NotificationsScreen
              onClose={closeNotifications}
              onNavigate={handleNotificationNavigate}
            />
          </Animated.View>
        )}
        {sentMailsOpen && !chatOpen && !openMail && !notificationsOpen && (
          <Animated.View
            key="sent-mails"
            style={StyleSheet.absoluteFill}
            entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
            exiting={SlideOutDown.duration(DURATION.modalExit)}
          >
            <SentMailScreen onClose={() => setSentMailsOpen(false)} />
          </Animated.View>
        )}
        {sessionOverlays}
      </View>
      {memoryConsentModal}
      {!chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && !icloudSetupOpen && !adminConsentOpen && !onboardingOpen && !authSheetOpen && (
        <View
          style={styles.chrome}
          pointerEvents="box-none"
          onLayout={(e) => setChromeHeight(e.nativeEvent.layout.height)}
        >
          <PhoneChrome
            active={tab}
            onChange={switchTab}
            onAskZolva={() => requireAuth(openChat)}
            darkBg={chromeOverDark}
            badges={{ today: pendingProposalCount }}
          />
        </View>
      )}
      {loggedOut && chromeHeight > 0 && !chatOpen && !openMail && !notificationsOpen && !sentMailsOpen && !icloudSetupOpen && !adminConsentOpen && !onboardingOpen && !authSheetOpen && (
        <LoginCtaBar
          onPress={openAuthSheet}
          bottomOffset={chromeHeight}
          onLayout={(e) => setCtaBarHeight(e.nativeEvent.layout.height)}
        />
      )}
      <StatusBarScrim />
    </View>
    </ChromeInsetsContext.Provider>
    </ErrorBoundary>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  // Match the active theme's paper (direction G = '#FBFBFA') so brief
  // moments where the root or content shows through during tab crossfades
  // don't flash the legacy warm cream behind the new airbrushy backdrop.
  root: { flex: 1, backgroundColor: '#FBFBFA' },
  content: { flex: 1, backgroundColor: '#FBFBFA' },
  chrome: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 10, elevation: 10 },
});
