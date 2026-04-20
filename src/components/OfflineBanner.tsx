import NetInfo from '@react-native-community/netinfo';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const reachable =
        state.isConnected !== false && state.isInternetReachable !== false;
      setOffline(!reachable);
    });
    return unsub;
  }, []);

  if (!offline) return null;
  return (
    <View
      style={styles.banner}
      accessibilityRole="alert"
      accessibilityLabel="Ingen internetforbindelse"
    >
      <Text style={styles.text}>Ingen internetforbindelse</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingTop: 48,
    paddingBottom: 8,
    paddingHorizontal: 16,
    backgroundColor: colors.ink,
    alignItems: 'center',
  },
  text: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    letterSpacing: 0.4,
    color: colors.paper,
  },
});
