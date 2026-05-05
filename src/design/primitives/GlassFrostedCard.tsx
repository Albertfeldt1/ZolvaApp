import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, StyleProp, View, ViewStyle } from 'react-native';
import { useTheme } from '../useTheme';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  /** Override card radius. Defaults to theme's small card radius. */
  radius?: number;
  /** Override the rgba overlay color above the blur. Defaults to surface.glass. */
  overlay?: string;
};

export function GlassFrostedCard({
  children,
  style,
  intensity,
  radius,
  overlay,
}: Props) {
  const { radius: R, surface, shadows, blur, t } = useTheme();
  const r = radius ?? R.cardSm;
  const blurIntensity = intensity ?? blur.card;

  // BlurView is weak / no-op on older Android — bump the overlay so the
  // card still reads as glass without the blur.
  const overlayColor =
    Platform.OS === 'android' ? surface.glassAndroidFallback : (overlay ?? surface.glass);

  return (
    <View
      style={[
        {
          borderRadius: r,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: surface.glassRim,
          ...shadows.softCard,
        },
        style,
      ]}
    >
      <BlurView intensity={blurIntensity} tint={t.mode === 'dark' ? 'dark' : 'light'} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: overlayColor }}>{children}</View>
      </BlurView>
    </View>
  );
}
