import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';

type TabPaneProps = {
  active: boolean;
  children: React.ReactNode;
};

// Wraps a tab screen so it stays mounted across tab switches. Crossfades
// opacity when active flips. Inactive panes don't intercept touches and sit
// behind the active one. Keeping screens alive preserves their state, scroll
// position, and already-fetched data — tab switches feel instant instead of
// re-fetching on every visit.
export function TabPane({ active, children }: TabPaneProps) {
  const opacity = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    opacity.value = withTiming(active ? 1 : 0, {
      duration: active ? 220 : 160,
      easing: Easing.out(Easing.quad),
    });
  }, [active, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, animatedStyle]}
      pointerEvents={active ? 'auto' : 'none'}
    >
      {children}
    </Animated.View>
  );
}
