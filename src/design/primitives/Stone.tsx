import React from 'react';
import { Pressable } from 'react-native';
import Animated from 'react-native-reanimated';
import Stone24 from '../../../assets/stone/zolva-stone-24.svg';
import Stone32 from '../../../assets/stone/zolva-stone-32.svg';
import Stone48 from '../../../assets/stone/zolva-stone-48.svg';
import Stone88 from '../../../assets/stone/zolva-stone-88.svg';
import Stone256 from '../../../assets/stone/zolva-stone-256.svg';
import { useStoneJump } from '../motion/useStoneJump';
import { useTheme } from '../useTheme';

type Props = {
  size?: number;
  jumpOnTap?: boolean;
  onPress?: () => void;
};

function pickSvg(size: number) {
  if (size <= 26) return Stone24;
  if (size <= 38) return Stone32;
  if (size <= 64) return Stone48;
  if (size <= 128) return Stone88;
  return Stone256;
}

export function Stone({ size = 32, jumpOnTap = true, onPress }: Props) {
  const { style, trigger } = useStoneJump(size);
  const { shadows } = useTheme();
  const Svg = pickSvg(size);

  const handlePress = () => {
    if (jumpOnTap) trigger();
    onPress?.();
  };

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={4}
      style={{
        width: size,
        height: size,
        ...shadows.stoneCast,
      }}
    >
      <Animated.View style={[{ width: size, height: size }, style]}>
        <Svg width={size} height={size} />
      </Animated.View>
    </Pressable>
  );
}
