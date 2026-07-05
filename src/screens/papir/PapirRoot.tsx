import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthSheet } from '../AuthSheet';
import { papirColor, papirDuration } from '../../design/papir';
import { PapirShell } from './PapirShell';

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
