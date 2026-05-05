import { BlurView } from 'expo-blur';
import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../useTheme';

type HaloKey = 'today' | 'mem';

type Halo = {
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  size: number;
  color: HaloKey;
  opacity: number;
};

const HALOS: Halo[] = [
  { top: -100, left: -80,    size: 340, color: 'today', opacity: 0.65 },
  { top: 40,   right: -110,  size: 300, color: 'mem',   opacity: 0.55 },
  { top: 340,  left: -60,    size: 260, color: 'today', opacity: 0.35 },
  { bottom: 120, right: -60, size: 240, color: 'mem',   opacity: 0.35 },
];

export function GlassHaloLayer() {
  const { t, blur } = useTheme();
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}
    >
      {HALOS.map((h, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            top: h.top,
            left: h.left,
            right: h.right,
            bottom: h.bottom,
            width: h.size,
            height: h.size,
            borderRadius: h.size / 2,
            backgroundColor: t[h.color],
            opacity: h.opacity,
          }}
        />
      ))}
      <BlurView
        intensity={blur.haloField}
        tint={t.mode === 'dark' ? 'dark' : 'light'}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
    </View>
  );
}
