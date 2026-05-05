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
  /** rgba overlay color above the blur. Defaults to white 0.65. */
  overlay?: string;
};

export function GlassFrostedCard({
  children,
  style,
  intensity = 45,
  radius,
  overlay = 'rgba(255,255,255,0.65)',
}: Props) {
  const { radius: R } = useTheme();
  const r = radius ?? R.cardSm;

  // BlurView is weak / no-op on older Android — bump the overlay so the
  // card still reads as glass without the blur.
  const overlayColor = Platform.OS === 'android' ? 'rgba(255,255,255,0.85)' : overlay;

  return (
    <View
      style={[
        {
          borderRadius: r,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.8)',
          shadowColor: '#0F1014',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.06,
          shadowRadius: 16,
          elevation: 2,
        },
        style,
      ]}
    >
      <BlurView intensity={intensity} tint="light" style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: overlayColor }}>{children}</View>
      </BlurView>
    </View>
  );
}
