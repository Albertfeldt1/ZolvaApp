import { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

const SPRING_OUT = Easing.bezier(0.34, 1.56, 0.64, 1);

export function useStoneJump(size: number) {
  const ty = useSharedValue(0);
  const sx = useSharedValue(1);
  const sy = useSharedValue(1);
  const amp = -0.55 * size;

  const trigger = () => {
    sx.value = withSequence(
      withTiming(1.10, { duration: 90 }),
      withTiming(0.94, { duration: 120 }),
      withTiming(0.96, { duration: 150 }),
      withTiming(1.06, { duration: 120 }),
      withTiming(1.00, { duration: 120, easing: SPRING_OUT }),
    );
    sy.value = withSequence(
      withTiming(0.85, { duration: 90 }),
      withTiming(1.08, { duration: 120 }),
      withTiming(1.04, { duration: 150 }),
      withTiming(0.92, { duration: 120 }),
      withTiming(1.00, { duration: 120, easing: SPRING_OUT }),
    );
    ty.value = withSequence(
      withTiming(0,           { duration: 90 }),
      withTiming(amp,         { duration: 120 }),
      withTiming(amp * 0.55,  { duration: 150 }),
      withTiming(0,           { duration: 120 }),
      withTiming(0,           { duration: 120, easing: SPRING_OUT }),
    );
  };

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: ty.value },
      { scaleX: sx.value },
      { scaleY: sy.value },
    ],
  }));

  return { style, trigger };
}
