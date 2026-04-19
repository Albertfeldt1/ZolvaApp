import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Stop } from 'react-native-svg';
import { colors } from '../theme';

export type StoneMood = 'calm' | 'thinking' | 'happy';

type StoneProps = {
  mood?: StoneMood;
  size?: number;
  onPress?: () => void;
};

const DIRS = [
  { x: 0, y: 0 },
  { x: -1.4, y: 0 },
  { x: 1.4, y: 0 },
  { x: -0.8, y: -0.8 },
  { x: 0.8, y: -0.8 },
  { x: 0, y: 0.6 },
];

const MOUTH: Record<StoneMood, string> = {
  calm: 'M 22 34 q 5 2 10 0',
  thinking: 'M 22 35 q 5 1 10 0',
  happy: 'M 20 33 q 7 6 14 0',
};

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function Stone({ mood = 'calm', size = 44, onPress }: StoneProps) {
  const [blink, setBlink] = useState(false);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const gazeCurrentRef = useRef({ x: 0, y: 0 });
  const hop = useRef(new Animated.Value(0)).current;
  const uid = React.useId().replace(/:/g, '');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let closeTimer: ReturnType<typeof setTimeout>;
    const loop = () => {
      setBlink(true);
      closeTimer = setTimeout(() => setBlink(false), 130);
      timer = setTimeout(loop, 3000 + Math.random() * 3500);
    };
    timer = setTimeout(loop, 1800 + Math.random() * 1500);
    return () => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let raf: number | null = null;
    const tweenTo = (target: { x: number; y: number }) => {
      if (raf) cancelAnimationFrame(raf);
      const start = now();
      const from = { ...gazeCurrentRef.current };
      const step = () => {
        const p = Math.min(1, (now() - start) / 420);
        const e = easeOutCubic(p);
        const next = {
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
        };
        gazeCurrentRef.current = next;
        setGaze(next);
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const loop = () => {
      tweenTo(DIRS[Math.floor(Math.random() * DIRS.length)]);
      timer = setTimeout(loop, 2000 + Math.random() * 2200);
    };
    timer = setTimeout(loop, 900 + Math.random() * 1200);
    return () => {
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
    hop.setValue(0);
    Animated.timing(hop, {
      toValue: 1,
      duration: 1150,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
    onPress?.();
  };

  const hopInput = [0, 0.12, 0.38, 0.55, 0.78, 0.92, 1];
  const translateY = hop.interpolate({
    inputRange: hopInput,
    outputRange: [0, 3, -16, -14, 2, 0, 0],
  });
  const scaleX = hop.interpolate({
    inputRange: hopInput,
    outputRange: [1, 1.08, 0.95, 0.96, 1.08, 0.99, 1],
  });
  const scaleY = hop.interpolate({
    inputRange: hopInput,
    outputRange: [1, 0.9, 1.08, 1.06, 0.93, 1.01, 1],
  });

  const eyeScaleY = blink ? 0.08 : 1;
  const pupilX = gaze.x * 0.5;
  const pupilY = gaze.y * 0.5;

  const body = (
    <Animated.View style={{ transform: [{ translateY }, { scaleX }, { scaleY }] }}>
      <Svg viewBox="0 0 54 48" width={size} height={(size * 48) / 54}>
        <Defs>
          <RadialGradient id={`sf${uid}`} cx="35%" cy="30%" r="75%">
            <Stop offset="0%" stopColor="#8B9B7F" />
            <Stop offset="55%" stopColor="#5C7355" />
            <Stop offset="100%" stopColor="#3D4E38" />
          </RadialGradient>
        </Defs>
        <Path
          d="M 4 28 C 2 14 14 2 28 3 C 44 4 54 18 50 32 C 47 43 34 48 22 46 C 10 44 6 38 4 28 Z"
          fill={`url(#sf${uid})`}
        />
        <Ellipse cx={20} cy={14} rx={6} ry={3} fill="rgba(255,255,255,0.25)" />
        <G transform={`translate(19 22) scale(1 ${eyeScaleY})`}>
          <Circle r={3.2} fill={colors.ink} cx={pupilX} cy={pupilY} />
          <Circle r={1.1} fill={colors.paper} cx={pupilX - 0.9} cy={pupilY - 1} />
        </G>
        <G transform={`translate(33 22) scale(1 ${eyeScaleY})`}>
          <Circle r={3.2} fill={colors.ink} cx={pupilX} cy={pupilY} />
          <Circle r={1.1} fill={colors.paper} cx={pupilX - 0.9} cy={pupilY - 1} />
        </G>
        {size >= 30 && (
          <Path
            d={MOUTH[mood]}
            stroke={colors.ink}
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
            opacity={0.5}
          />
        )}
      </Svg>
    </Animated.View>
  );

  return (
    <Pressable onPress={handlePress} hitSlop={6}>
      {body}
    </Pressable>
  );
}
