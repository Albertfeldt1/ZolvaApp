import React, { useEffect, useState } from 'react';
import { AppState, BackHandler, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScaleButton } from '../../design/motion';
import { AuthSheet } from '../AuthSheet';
import { refreshCalendarNow, refreshMailNow, refreshRemindersNow } from '../../lib/hooks';
import { PaperText, papirColor, papirDuration, papirRadius, papirSpace } from '../../design/papir';
import { PapirShell } from './PapirShell';

/** Only refetch after a real absence: quick hops (share sheet, 2FA in Safari,
 * app-switcher peek) stay on iOS's active↔inactive path and never hit
 * 'background', and short backgroundings under this threshold skip the
 * refresh too, so we don't blast provider APIs on every app switch. */
const FOREGROUND_REFRESH_MS = 60_000;

/** Refresh mail, calendar and reminders when the app returns to the
 * foreground after being backgrounded a while. Data written while the app
 * was away (push-created reminders, new mail, events added by attendees)
 * shows up without pull-to-refresh or a cold restart. */
function useForegroundRefresh() {
  useEffect(() => {
    let backgroundedAt: number | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundedAt = Date.now();
      } else if (state === 'active') {
        if (backgroundedAt != null && Date.now() - backgroundedAt >= FOREGROUND_REFRESH_MS) {
          refreshMailNow();
          refreshCalendarNow();
          refreshRemindersNow();
        }
        backgroundedAt = null;
      }
    });
    return () => sub.remove();
  }, []);
}

/** Persistent login affordance for logged-out sessions (H1): without it the
 * only login path is buried in Profil, and empty tabs read as "no data"
 * rather than "not signed in". Sits just above the bottom nav. */
function LoginCta({ onPress }: { onPress: () => void }) {
  const insets = useSafeAreaInsets();
  const navHeight = 68 + Math.max(insets.bottom, 16);
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end', zIndex: 60 }]}>
      <View
        style={{
          marginBottom: navHeight + 8,
          marginHorizontal: papirSpace.screen,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: papirColor.ink,
          borderRadius: papirRadius.xl,
          paddingVertical: 12,
          paddingHorizontal: 16,
        }}
      >
        <PaperText role="small" color={papirColor.onInk} style={{ flex: 1 }}>
          Du er ikke logget ind — dine mails, møder og noter vises ikke.
        </PaperText>
        <ScaleButton
          scaleTo={0.95}
          haptic="light"
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel="Log ind"
          style={{
            backgroundColor: papirColor.paper,
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderRadius: papirRadius.pill,
          }}
        >
          <PaperText role="small" color={papirColor.ink}>
            Log ind
          </PaperText>
        </ScaleButton>
      </View>
    </View>
  );
}

type Props = {
  /** From App.tsx's auth state — used to surface login affordances. */
  loggedOut: boolean;
};

/**
 * Papir mounted inside the real app: App.tsx renders this INSTEAD of the
 * classic chrome when the dev toggle is on. All of App.tsx's boot effects
 * (auth, RevenueCat, push, deep links, widget snapshot) keep running above
 * us — this is a different face on the same running app, not a sandbox.
 *
 * SafeAreaProvider wraps only the Papir subtree: the classic UI still uses
 * its own fixed offsets and must remain byte-identical when the toggle is off.
 */
export function PapirRoot({ loggedOut }: Props) {
  const [authOpen, setAuthOpen] = useState(false);
  useForegroundRefresh();

  // Android hardware back closes the auth sheet (K4). PapirRoot mounts
  // before PapirShell, so React registers the shell's handler LAST — RN's
  // BackHandler is LIFO, so this effect re-registers on every authOpen flip
  // to jump the queue while the sheet is up.
  useEffect(() => {
    if (!authOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setAuthOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [authOpen]);
  // Papir screens request login via nav.openAuth() (e.g. Profil's "Log ind",
  // or actions that hit an auth wall). The sheet is the classic AuthSheet —
  // login is identical in both UIs by design.
  const openAuth = () => {
    if (loggedOut) setAuthOpen(true);
  };

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <StatusBar style="dark" />
        <PapirShell openAuth={openAuth} />
        {loggedOut && !authOpen ? <LoginCta onPress={() => setAuthOpen(true)} /> : null}
        {authOpen ? (
          <Animated.View
            entering={SlideInDown.duration(papirDuration.overlay)}
            exiting={SlideOutDown.duration(papirDuration.overlay - 100)}
            style={[StyleSheet.absoluteFill, { zIndex: 100 }]}
          >
            <AuthSheet onClose={() => setAuthOpen(false)} />
          </Animated.View>
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}
