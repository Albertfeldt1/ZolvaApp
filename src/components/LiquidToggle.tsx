import { GlassView } from 'expo-glass-effect';
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { liquidGlassReady } from '../lib/liquid-glass';
import { colors } from '../theme';

const TOGGLE_EASING = Easing.bezier(0.22, 1, 0.36, 1);
const TOGGLE_DURATION = 220;

type Props = {
  value: boolean;
  onChange: (next: boolean) => void;
  width: number;
  height: number;
  padding: number;
  /** Track tint when off. In glass mode pass rgba with alpha so the glass shows through. */
  tintOff: string;
  /** Track tint when on. In glass mode pass rgba with alpha for the liquid feel; opaque is fine for non-glass fallback. */
  tintOn: string;
  thumbColor?: string;
  accessibilityLabel?: string;
};

export function LiquidToggle({
  value,
  onChange,
  width,
  height,
  padding,
  tintOff,
  tintOn,
  thumbColor = colors.paper,
  accessibilityLabel,
}: Props) {
  const thumbSize = height - padding * 2;
  const travel = width - padding * 2 - thumbSize;
  const radius = height / 2;

  const progress = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, {
      duration: TOGGLE_DURATION,
      easing: TOGGLE_EASING,
    });
  }, [value, progress]);

  const tintStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [tintOff, tintOn]),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * travel }],
  }));

  // The GlassView (when liquidGlassReady) IS the capsule — matching the
  // pattern in LiquidTabBar where GlassView wraps content directly. Putting
  // it behind another View as an absolute-fill underlay does not reliably
  // render the UIGlassEffectView blur on iOS 26.
  const trackBase = {
    width,
    height,
    borderRadius: radius,
    padding,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    overflow: 'hidden' as const,
  };

  const trackChildren = (
    <>
      <Animated.View
        style={[StyleSheet.absoluteFill, { borderRadius: radius }, tintStyle]}
        pointerEvents="none"
      />
      <Animated.View
        style={[
          {
            width: thumbSize,
            height: thumbSize,
            borderRadius: thumbSize / 2,
            backgroundColor: thumbColor,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.18,
            shadowRadius: 3,
            elevation: 2,
          },
          thumbStyle,
        ]}
      />
    </>
  );

  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
    >
      {liquidGlassReady ? (
        <GlassView
          glassEffectStyle="regular"
          colorScheme="auto"
          style={trackBase}
        >
          {trackChildren}
        </GlassView>
      ) : (
        <View style={trackBase}>{trackChildren}</View>
      )}
    </Pressable>
  );
}
