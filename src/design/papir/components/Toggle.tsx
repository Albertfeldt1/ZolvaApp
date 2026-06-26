import React, { useCallback } from 'react';
import { Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from 'react-native-reanimated';
import { papirColor, papirDuration, papirEasing } from '../tokens';

type Props = {
  value: boolean;
  onValueChange?: (v: boolean) => void;
};

/** iOS-style switch. off = ink4 track, on = green; knob springs across. */
export function Toggle({ value, onValueChange }: Props) {
  const progress = useDerivedValue(
    () => withTiming(value ? 1 : 0, { duration: papirDuration.toggle, easing: papirEasing }),
    [value],
  );
  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [papirColor.ink4, papirColor.green]),
  }));
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * 18 }] }));

  const toggle = useCallback(() => {
    void Haptics.selectionAsync();
    onValueChange?.(!value);
  }, [value, onValueChange]);

  return (
    <Pressable onPress={toggle} hitSlop={6} accessibilityRole="switch" accessibilityState={{ checked: value }}>
      <Animated.View
        style={[{ width: 46, height: 28, borderRadius: 999, padding: 3, justifyContent: 'center' }, track]}
      >
        <Animated.View
          style={[
            {
              width: 22,
              height: 22,
              borderRadius: 999,
              backgroundColor: '#FFFFFF',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.2,
              shadowRadius: 3,
              elevation: 2,
            },
            knob,
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}
