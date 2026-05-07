import { BlurView } from 'expo-blur';
import { GlassView } from 'expo-glass-effect';
import React from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import { liquidGlassReady } from '../../lib/liquid-glass';
import { useTheme } from '../useTheme';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  /** Override card radius. Defaults to theme's small card radius. */
  radius?: number;
  /** Background fill (when omitted, renders as a near-opaque bone-white
   *  card). Pass a semantic tint like surface.warningTint or
   *  surface.glassDark to ride the iOS 26 Liquid Glass material instead
   *  of a flat fill. */
  overlay?: string;
  /** Glass intensity preset. Only meaningful for non-fill tints that
   *  flow through the native Liquid Glass / BlurView path. */
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

  // Most callers want a near-opaque cream "card" surface, not a glass
  // material. iOS 26's native UIGlassEffectView attenuates flat tint
  // values further than expected, which made bone-white cards bleed
  // through to nothing on saturated backdrops (only the rim survived).
  // Detect the fill-style overlays and short-circuit to a plain View
  // with the overlay as backgroundColor - no blur, no glass.
  const isFillOverlay =
    !overlay ||
    overlay === surface.bone ||
    overlay === surface.glass ||
    overlay === surface.glassStrong ||
    overlay === surface.glassWeak ||
    overlay === surface.glassAndroidFallback;

  if (isFillOverlay) {
    return (
      <View
        style={[
          {
            backgroundColor: overlay ?? surface.bone,
            borderRadius: r,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: surface.glassRim,
            ...shadows.softCard,
          },
          style,
        ]}
      >
        {children}
      </View>
    );
  }

  // Semantic tints (warningTint, successTint, glassDark, …) ride the
  // glass material. iOS 26+ uses native Liquid Glass; older iOS and
  // Android fall back to BlurView + the tint as an opaque fill.
  if (liquidGlassReady) {
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
          tintColor={overlay}
        >
          <View style={style}>{children}</View>
        </GlassView>
      </View>
    );
  }

  const blurIntensity = intensity ?? blur.card;
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
        <View style={[{ backgroundColor: overlay }, style]}>{children}</View>
      </BlurView>
    </View>
  );
}
