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
import { StatusBarScrim } from './src/components/StatusBarScrim';
import { CalendarScreen } from './src/screens/CalendarScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { InboxDetailScreen } from './src/screens/InboxDetailScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { MemoryScreen } from './src/screens/MemoryScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TodayScreen } from './src/screens/TodayScreen';
import { runStartupMigrations } from './src/lib/migrations';
import { syncOnAppForeground } from './src/lib/notifications';
import { initNotificationSettings } from './src/lib/notification-settings';
import type { InboxMail } from './src/lib/types';
import { colors } from './src/theme';

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

  const [tab, setTab] = useState<TabId>('today');
  const [chatOpen, setChatOpen] = useState(false);
  const [openMail, setOpenMail] = useState<InboxMail | null>(null);
  const [chromeOverDark, setChromeOverDark] = useState(false);
  const [chromeHeight, setChromeHeight] = useState(0);

  useEffect(() => {
    void runStartupMigrations();
  }, []);

  useEffect(() => {
    initNotificationSettings();
    void syncOnAppForeground();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncOnAppForeground();
    });
    return () => sub.remove();
  }, []);

  // Shadow from the tab bar bleeds a few pixels above its measured box;
  // a small buffer keeps the last line of content clear of it.
  const chromeInsets = useMemo(
    () => ({ bottom: chromeHeight > 0 ? chromeHeight + 12 : 0 }),
    [chromeHeight],
  );

  if (!fraunces || !playfair || !inter || !mono) {
    return <View style={[styles.root, { backgroundColor: colors.paper }]} />;
  }

  const openChat = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setChatOpen(true);
  };

  const closeChat = () => {
    Haptics.selectionAsync();
    setChatOpen(false);
  };

  const switchTab = (t: TabId) => {
    if (t !== tab || chatOpen) {
      Haptics.selectionAsync();
    }
    setTab(t);
    setChatOpen(false);
    setOpenMail(null);
    if (t !== 'today' && t !== 'inbox') setChromeOverDark(false);
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
    <ChromeInsetsContext.Provider value={chromeInsets}>
    <View style={styles.root}>
      <StatusBar style="dark" translucent />
      <View style={styles.content}>
        {chatOpen ? (
          <Animated.View
            key="chat"
            style={StyleSheet.absoluteFill}
            entering={SlideInDown.duration(320)}
            exiting={SlideOutDown.duration(260)}
          >
            <ChatScreen onBack={closeChat} />
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
                onGoToSettings={() => switchTab('settings')}
                onGoToMemory={() => switchTab('memory')}
                onOverDarkChange={setChromeOverDark}
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
      </View>
      {!chatOpen && !openMail && (
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
    </View>
    </ChromeInsetsContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { flex: 1, backgroundColor: colors.paper },
  chrome: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
