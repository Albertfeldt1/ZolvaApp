import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { papirColor } from '../../design/papir';

const BAR_COUNT = 5;
const STAGGER_MS = 110;
const HALF_CYCLE_MS = 340;

/** Branded loader: the record screen's waveform, idling. Replaces the stock
 * ActivityIndicator on Papir screens so even waiting speaks the app's voice
 * language. Pure transform animation (native driver) — no layout thrash. */
export function PapirLoader({ color = papirColor.red, size = 22 }: { color?: string; size?: number }) {
  const phases = useRef(Array.from({ length: BAR_COUNT }, () => new Animated.Value(0))).current;

  useEffect(() => {
    const loops = phases.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          // Stagger via a leading delay INSIDE the loop's first pass only
          // would desync on repeat — keep the delay out here instead.
          Animated.timing(v, {
            toValue: 1,
            duration: HALF_CYCLE_MS,
            delay: i * STAGGER_MS,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0,
            duration: HALF_CYCLE_MS,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [phases]);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Indlæser"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: size }}
    >
      {phases.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: 3,
            height: size,
            borderRadius: 2,
            backgroundColor: color,
            transform: [{ scaleY: v.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }],
          }}
        />
      ))}
    </View>
  );
}
