import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Dimensions, View } from 'react-native';
import { useTheme } from '../useTheme';

// Continuous, airbrushy wash of color across the screen. A diagonal
// linear gradient handles the broad peach → paper → lavender blend, then
// two oversized soft halos add organic depth, and a heavy BlurView fuses
// the whole thing into one smooth atmosphere with no visible seams.
export function GlassHaloLayer() {
  const { t, blur } = useTheme();
  const { width: W, height: H } = Dimensions.get('window');
  const big = Math.max(W, H);

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}
    >
      <LinearGradient
        colors={[
          withAlpha(t.today, 0.38),
          withAlpha(t.mem, 0.38),
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        style={{
          position: 'absolute',
          top: -big * 0.25,
          left: -big * 0.25,
          width: big * 1.1,
          height: big * 1.1,
          borderRadius: (big * 1.1) / 2,
          backgroundColor: t.today,
          opacity: 0.14,
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: -big * 0.3,
          right: -big * 0.3,
          width: big * 1.2,
          height: big * 1.2,
          borderRadius: (big * 1.2) / 2,
          backgroundColor: t.mem,
          opacity: 0.14,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: big * 0.05,
          right: -big * 0.15,
          width: big * 0.55,
          height: big * 0.55,
          borderRadius: (big * 0.55) / 2,
          backgroundColor: '#FFFFFF',
          opacity: 0.28,
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: big * 0.1,
          left: -big * 0.2,
          width: big * 0.5,
          height: big * 0.5,
          borderRadius: (big * 0.5) / 2,
          backgroundColor: '#FFFFFF',
          opacity: 0.22,
        }}
      />
      <BlurView
        intensity={blur.haloField}
        tint={t.mode === 'dark' ? 'dark' : 'light'}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
    </View>
  );
}

function withAlpha(hex: string, alpha: number): string {
  // Accept hex (#RRGGBB) or already-rgba; pass others through.
  if (hex.startsWith('#') && hex.length === 7) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return hex;
}
