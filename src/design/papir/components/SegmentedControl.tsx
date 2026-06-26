import React, { useState } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import {
  papirColor,
  papirDuration,
  papirEasing,
  papirRadius,
  papirShadow,
  papirSpace,
} from '../tokens';
import { PaperText } from './PaperText';

type Props = {
  options: string[];
  value: number;
  onChange: (index: number) => void;
};

const PAD = 4;

/** Segmented control with a sliding active pill (measures its own width). */
export function SegmentedControl({ options, value, onChange }: Props) {
  const [trackW, setTrackW] = useState(0);
  const segW = trackW > 0 ? (trackW - PAD * 2) / options.length : 0;

  const pill = useAnimatedStyle(() => ({
    width: segW,
    transform: [
      { translateX: withTiming(value * segW, { duration: papirDuration.segment, easing: papirEasing }) },
    ],
  }));

  const onLayout = (e: LayoutChangeEvent) => setTrackW(e.nativeEvent.layout.width);

  return (
    <View
      onLayout={onLayout}
      style={{
        flexDirection: 'row',
        backgroundColor: papirColor.paper2,
        borderRadius: papirRadius.md,
        padding: PAD,
      }}
    >
      {segW > 0 ? (
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: PAD,
              bottom: PAD,
              left: PAD,
              borderRadius: papirRadius.md - 3,
              backgroundColor: papirColor.card,
            },
            papirShadow.sm,
            pill,
          ]}
        />
      ) : null}
      {options.map((opt, i) => (
        <Pressable
          key={opt}
          onPress={() => {
            void Haptics.selectionAsync();
            onChange(i);
          }}
          style={{ flex: 1, paddingVertical: papirSpace.md - 2, alignItems: 'center' }}
        >
          <PaperText role="bodyStrong" color={i === value ? papirColor.ink : papirColor.ink2}>
            {opt}
          </PaperText>
        </Pressable>
      ))}
    </View>
  );
}
