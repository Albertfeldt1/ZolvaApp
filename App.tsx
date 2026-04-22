import {
  Fraunces_500Medium,
  useFonts as useFraunces,
} from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_500Medium_Italic,
  Inter_600SemiBold,
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
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { ChromeInsetsContext, PhoneChrome, TabId } from './src/components/PhoneChrome';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { IntroVideo } from './src/components/IntroVideo';
import { OfflineBanner } from './src/components/OfflineBanner';
import { StatusBarScrim } from './src/components/StatusBarScrim';
import { CalendarScreen } from './src/screens/CalendarScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { InboxDetailScreen } from './src/screens/InboxDetailScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { MemoryScreen } from './src/screens/MemoryScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TodayScreen } from './src/screens/TodayScreen';
import { runStartupMigrations } from './src/lib/migrations';
import { registerResponseHandler, syncOnAppForeground } from './src/lib/notifications';
import { initNotificationSettings } from './src/lib/notification-settings';
import { initNotificationFeed, markFeedByPayload } from './src/lib/notification-feed';
import type { InboxMail, NotificationPayload } from './src/lib/types';
import { colors } from './src/theme';
import { useAuth } from './src/lib/auth';
import { shouldShowMemoryConsent, markMemoryConsentShown } from './src/lib/hooks';
import { MemoryConsentModal } from './src/components/MemoryConsentModal';
import { isDemoUser } from './src/lib/demo';
import { syncUserProfile } from './src/lib/user-profile';

const PROFILE_MEMORY_FLAG = process.env.EXPO_PUBLIC_PROFILE_MEMORY === '1';

// Module-level flag — persists across component re-renders and across
// background/foreground transitions (JS VM stays warm), but resets on cold
// start (new VM → module re-evaluated). That's exactly "play once per
// cold launch, skip on resume from background".
let introShownThisSession = false;

export default function App() {
  const [fraunces] = useFraunces({
    Fraunces_500Medium,
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
  });
  const [mono] = useJetBrains({
    JetBrainsMono_400Regular,
    JetBrainsMono_600SemiBold,
  });

  const { user } = useAuth();
  const [introPlaying, setIntroPlaying] = useState(!introShownThisSession);
  const dismissIntro = () => {
    introShownThisSession = true;
    setIntroPlaying(false);
  };
  const [tab, setTab] = useState<TabId>('today');
  const [chatOpen, setChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState<string | undefined>(undefined);
  const [openMail, setOpenMail] = useState<InboxMail | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [chromeOverDark, setChromeOverDark] = useState(false);
  const [chromeHeight, setChromeHeight] = useState(0);
  const [migrationsDone, setMigrationsDone] = useState(false);
  const [memoryConsentOpen, setMemoryConsentOpen] = useState(false);
  // Bumped whenever a 'brief' push or in-app notification row is tapped.
  // TodayScreen opens the brief modal on each change.
  const [briefOpenTrigger, setBriefOpenTrigger] = useState(0);

  useEffect(() => {
    if (!PROFILE_MEMORY_FLAG) return;
    if (!user?.id) return;
    let cancelled = false;
    void shouldShowMemoryConsent(user.id).then((show) => {
      if (cancelled || !show) return;
      setMemoryConsentOpen(true);
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || isDemoUser(user)) return;
    syncUserProfile(user.id);
  }, [user?.id]);

  // Gate render on migrations. Screens read legacy AsyncStorage keys during
  // mount — if a previous user's data hasn't been purged yet, it would leak
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
    let inflight: Promise<void> | null = null;
    const runSync = () => {
      if (inflight) return;
      inflight = syncOnAppForeground().finally(() => {
        inflight = null;
      });
    };
    runSync();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') runSync();
    });
    return () => sub.remove();
  }, [migrationsDone]);

  useEffect(() => {
    if (!chatOpen) setChatDraft(undefined);
  }, [chatOpen]);

  useEffect(() => {
    const unsub = registerResponseHandler((payload) => {
      setChatOpen(false);
      setOpenMail(null);
      setNotificationsOpen(false);
      void markFeedByPayload(payload);
      switch (payload.type) {
        case 'reminder':
        case 'digest':
        case 'reminderAdded':
          setTab('today');
          break;
        case 'brief':
          setTab('today');
          setBriefOpenTrigger((v) => v + 1);
          break;
        case 'calendarPreAlert':
          setTab('calendar');
          break;
        case 'newMail':
          setTab('inbox');
          break;
      }
    });
    return unsub;
  }, []);

  // Shadow from the tab bar bleeds a few pixels above its measured box;
  // a small buffer keeps the last line of content clear of it.
  const chromeInsets = useMemo(
    () => ({ bottom: chromeHeight > 0 ? chromeHeight + 12 : 0 }),
    [chromeHeight],
  );

  if (!fraunces || !playfair || !inter || !mono || !migrationsDone) {
    return <View style={[styles.root, { backgroundColor: colors.paper }]} />;
  }

  const openChat = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setChatDraft(undefined);
    setChatOpen(true);
  };

  const openChatWithPrompt = (prompt: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setChatDraft(prompt);
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
    if (t !== 'today' && t !== 'inbox') setChromeOverDark(false);
  };

  const openNotifications = () => {
    Haptics.selectionAsync();
    setNotificationsOpen(true);
  };

  const closeNotifications = () => {
    Haptics.selectionAsync();
    setNotificationsOpen(false);
  };

  const handleNotificationNavigate = (payload: NotificationPayload) => {
    setNotificationsOpen(false);
    setChatOpen(false);
    setOpenMail(null);
    switch (payload.type) {
      case 'reminder':
      case 'digest':
      case 'reminderAdded':
        setTab('today');
        break;
      case 'brief':
        setTab('today');
        setBriefOpenTrigger((v) => v + 1);
        break;
      case 'calendarPreAlert':
        setTab('calendar');
        break;
      case 'newMail':
        setTab('inbox');
        break;
    }
  };

  const openMailDetail = (m: InboxMail) => {
    Haptics.selectionAsync();
    setOpenMail(m);
  };

  const closeMailDetail = () => {
    Haptics.selectionAsync();
    setOpenMail(null);
  };

  return (
    <ErrorBoundary>
    <ChromeInsetsContext.Provider value={chromeInsets}>
    <View style={styles.root}>
      <StatusBar style="dark" translucent />
      <OfflineBanner />
      <View style={styles.content}>
        {chatOpen ? (
          <Animated.View
            key="chat"
            style={StyleSheet.absoluteFill}
            entering={SlideInDown.duration(320)}
            exiting={SlideOutDown.duration(260)}
          >
            <ChatScreen onBack={closeChat} initialDraft={chatDraft} />
          </Animated.View>
        ) : (
          <Animated.View
            key={tab}
            style={StyleSheet.absoluteFill}
            entering={FadeIn.duration(240)}
            exiting={FadeOut.duration(160)}
          >
            {tab === 'today' && (
              <TodayScreen
                onOpenChat={openChat}
                onOpenChatWithPrompt={openChatWithPrompt}
                onOpenMail={openMailDetail}
                onGoToSettings={() => switchTab('settings')}
                onGoToMemory={() => switchTab('memory')}
                onOpenNotifications={openNotifications}
                onOverDarkChange={setChromeOverDark}
                briefOpenTrigger={briefOpenTrigger}
              />
            )}
            {tab === 'inbox' && (
              <InboxScreen
                onGoToSettings={() => switchTab('settings')}
                onOpenMail={openMailDetail}
                onOverDarkChange={setChromeOverDark}
              />
            )}
            {tab === 'calendar' && <CalendarScreen onGoToSettings={() => switchTab('settings')} />}
            {tab === 'memory' && <MemoryScreen onOpenChat={openChat} />}
            {tab === 'settings' && <SettingsScreen />}
          </Animated.View>
        )}
        {openMail && !chatOpen && (
          <Animated.View
            key={`mail-${openMail.id}`}
            style={StyleSheet.absoluteFill}
            entering={SlideInDown.duration(320)}
            exiting={SlideOutDown.duration(260)}
          >
            <InboxDetailScreen mail={openMail} onClose={closeMailDetail} />
          </Animated.View>
        )}
        {notificationsOpen && !chatOpen && !openMail && (
          <Animated.View
            key="notifications"
            style={StyleSheet.absoluteFill}
            entering={SlideInDown.duration(320)}
            exiting={SlideOutDown.duration(260)}
          >
            <NotificationsScreen
              onClose={closeNotifications}
              onNavigate={handleNotificationNavigate}
            />
          </Animated.View>
        )}
      </View>
      {user?.id && (
        <MemoryConsentModal
          visible={memoryConsentOpen}
          userId={user.id}
          onClose={() => {
            const uid = user.id;
            setMemoryConsentOpen(false);
            void markMemoryConsentShown(uid);
          }}
        />
      )}
      {!chatOpen && !openMail && !notificationsOpen && (
        <View
          style={styles.chrome}
          pointerEvents="box-none"
          onLayout={(e) => setChromeHeight(e.nativeEvent.layout.height)}
        >
          <PhoneChrome
            active={tab}
            onChange={switchTab}
            onAskZolva={openChat}
            darkBg={chromeOverDark}
          />
        </View>
      )}
      <StatusBarScrim />
      {introPlaying && <IntroVideo onEnd={dismissIntro} />}
    </View>
    </ChromeInsetsContext.Provider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { flex: 1, backgroundColor: colors.paper },
  chrome: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
