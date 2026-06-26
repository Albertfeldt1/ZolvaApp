// The shared "this button is alive" primitive.
//
// A Pressable that springs down on press-in and back on release, with an
// optional haptic tick. This is the single biggest lever for making the app
// feel responsive instead of "dead/cheap": a tap that answers with a subtle
// scale + haptic reads as native. Runs entirely on the UI thread (Reanimated
// shared value), so it never janks even while JS is busy.
//
// Drop-in for <Pressable>: same props, plus `scaleTo` and `haptic`. Migrating a
// button usually means deleting its `opacity: pressed ? … : 1` style — the
// scale replaces that feedback.
import React, { useCallback } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { SPRING_PRESS } from './springs';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressHaptic = 'light' | 'medium' | 'soft' | 'selection' | 'none';

function fireHaptic(h: PressHaptic): void {
  switch (h) {
    case 'none':
      return;
    case 'selection':
      void Haptics.selectionAsync();
      return;
    case 'soft':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
      return;
    case 'medium':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    case 'light':
    default:
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
}

type Props = Omit<PressableProps, 'style'> & {
  /** Scale at full press. 0.96 = subtle (default); lower = more pronounced. */
  scaleTo?: number;
  /** Haptic fired on press-in. Defaults to 'light'; 'none' to disable. */
  haptic?: PressHaptic;
  /** Static style only (the scale transform is applied on top). */
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

export function ScaleButton({
  scaleTo = 0.96,
  haptic = 'light',
  style,
  children,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: Props) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePressIn = useCallback(
    (e: GestureResponderEvent) => {
      scale.value = withSpring(scaleTo, SPRING_PRESS);
      if (!disabled) fireHaptic(haptic);
      onPressIn?.(e);
    },
    [scaleTo, haptic, disabled, onPressIn, scale],
  );

  const handlePressOut = useCallback(
    (e: GestureResponderEvent) => {
      scale.value = withSpring(1, SPRING_PRESS);
      onPressOut?.(e);
    },
    [onPressOut, scale],
  );

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[animatedStyle, style]}
    >
      {children}
    </AnimatedPressable>
  );
}
