// Brand-bølgen i hvile — syv bjælker der trækker vejret i utakt.
//
// Zolvas levende signatur: samme organisme som optage-bølgen, men rolig.
// Hver bjælke looper sin egen scaleY-sinus med egen varighed og fase-
// forskydning, så bevægelsen aldrig repeterer synligt. `listening` løfter
// amplituden let ("Zolva arbejder/lytter"). Med Reducér bevægelse står
// bølgen stille. Alt kører som transform på UI-tråden — 60 fps garanteret.
//
// Bruges på tværs af logged-out/onboarding-fladerne (AuthSheet, backfill-
// kæden), så brandet følger brugeren fra første åbning til første briefing.
import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { papirColor, papirDuration, papirEasing, papirRadius } from '../tokens';

const DEFAULT_HEIGHTS = [16, 30, 22, 42, 26, 36, 18] as const;

function WaveBar({
  height,
  width,
  index,
  boost,
  reduced,
  color,
}: {
  height: number;
  width: number;
  index: number;
  boost: SharedValue<number>;
  reduced: boolean;
  color: string;
}) {
  const phase = useSharedValue(1);

  useEffect(() => {
    if (reduced) return;
    phase.value = withDelay(
      index * 150,
      withRepeat(
        withTiming(0.72, {
          duration: 1400 + ((index * 137) % 500),
          easing: Easing.inOut(Easing.sin),
        }),
        -1,
        true,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scaleY: phase.value * boost.value }],
  }));

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: papirRadius.pill,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

type Props = {
  /** Løfter amplituden let, mens Zolva arbejder. */
  listening?: boolean;
  /** Skalerer hele bølgen (1 = login-størrelsen, 46pt høj). */
  scale?: number;
  color?: string;
};

export function BreathingWave({ listening = false, scale = 1, color = papirColor.red }: Props) {
  const reduced = useReducedMotion();
  const boost = useSharedValue(1);

  useEffect(() => {
    boost.value = withTiming(listening && !reduced ? 1.3 : 1, {
      duration: papirDuration.overlay,
      easing: papirEasing,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, reduced]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5 * scale,
        height: 46 * scale,
      }}
    >
      {DEFAULT_HEIGHTS.map((h, i) => (
        <WaveBar
          key={i}
          height={h * scale}
          width={4 * scale}
          index={i}
          boost={boost}
          reduced={reduced}
          color={color}
        />
      ))}
    </View>
  );
}
