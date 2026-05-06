import { BlurView } from 'expo-blur';
import { GlassView } from 'expo-glass-effect';
import React from 'react';
import { Platform, StyleProp, View, ViewStyle } from 'react-native';
import { liquidGlassReady } from '../../lib/liquid-glass';
import { useTheme } from '../useTheme';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  /** Override card radius. Defaults to theme's small card radius. */
  radius?: number;
  /** Override the rgba overlay color above the blur. On iOS 26+ this is
   *  passed as the GlassView tint color; on older iOS / Android it's the
   *  opaque fill above the BlurView. */
  overlay?: string;
  /** Glass intensity preset. 'regular' is the default frosted look;
   *  'clear' lets halos bleed through more aggressively. Maps directly
   *  to the native glassEffectStyle on iOS 26+. */
  glassStyle?: 'regular' | 'clear';
};

export function GlassFrostedCard({
  children,
  style,
  intensity,
  radius,
  overlay,
  glassStyle = 'regular',
}: Props) {
  const { radius: R, surface, shadows, blur, t } = useTheme();
  const r = radius ?? R.cardSm;

  // Native iOS 26+ Liquid Glass — use UIGlassEffectView via expo-glass-effect.
  // Halos bleed through with the real refractive material; only semantic
  // overlays (warning, success, dark) ride as tintColor on the glass effect.
  // The "fill"-style overlays (bone, glass, glassStrong, glassWeak,
  // glassAndroidFallback) are skipped here because their high opacity would
  // wash out the native glass effect — let GlassView do the work instead.
  if (liquidGlassReady) {
    const isFillOverlay =
      !overlay ||
      overlay === surface.bone ||
      overlay === surface.glass ||
      overlay === surface.glassStrong ||
      overlay === surface.glassWeak ||
      overlay === surface.glassAndroidFallback;
    const isDarkOverlay = overlay === surface.glassDark;
    return (
      <View
        style={{
          borderRadius: r,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: surface.glassRim,
          ...shadows.softCard,
        }}
      >
        <GlassView
          glassEffectStyle={glassStyle}
          colorScheme={isDarkOverlay || t.mode === 'dark' ? 'dark' : 'light'}
          tintColor={isFillOverlay ? undefined : overlay}
        >
          <View style={style}>{children}</View>
        </GlassView>
      </View>
    );
  }

  // Older iOS / Android fallback — BlurView + opaque overlay. Android's
  // BlurView is weak/no-op on older devices, so the overlay opacity is
  // bumped to keep the card legible.
  const blurIntensity = intensity ?? blur.card;
  const overlayColor =
    Platform.OS === 'android' ? surface.glassAndroidFallback : (overlay ?? surface.glass);

  return (
    <View
      style={{
        borderRadius: r,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: surface.glassRim,
        ...shadows.softCard,
      }}
    >
      <BlurView intensity={blurIntensity} tint={t.mode === 'dark' ? 'dark' : 'light'}>
        <View style={[{ backgroundColor: overlayColor }, style]}>{children}</View>
      </BlurView>
    </View>
  );
}
