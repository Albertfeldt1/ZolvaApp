import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../useTheme';
import { Icon } from './Icon';

type Props = {
  eyebrow: string;
  onBell?: () => void;
  onGear?: () => void;
};

const ICON_BUTTON_SIZE = 34;
const ICON_GLYPH_SIZE = 16;
const HORIZONTAL_PAD = 20;

export function TopBar({ eyebrow, onBell, onGear }: Props) {
  const { t, type, surface, spacing, radius } = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: spacing.statusBarFallback,
        paddingHorizontal: HORIZONTAL_PAD,
      }}
    >
      <Text
        style={{
          fontSize: type.eyebrow.fontSize,
          lineHeight: type.eyebrow.lineHeight,
          letterSpacing: type.eyebrow.letterSpacing,
          fontFamily: type.eyebrow.fontFamily,
          textTransform: type.eyebrow.textTransform,
          color: t.ink3,
          fontWeight: '500',
        }}
      >
        {eyebrow}
      </Text>
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Pressable
          onPress={onBell}
          style={{
            width: ICON_BUTTON_SIZE,
            height: ICON_BUTTON_SIZE,
            borderRadius: radius.pill,
            backgroundColor: surface.iconButton,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon.bell size={ICON_GLYPH_SIZE} color={t.ink2} />
        </Pressable>
        <Pressable
          onPress={onGear}
          style={{
            width: ICON_BUTTON_SIZE,
            height: ICON_BUTTON_SIZE,
            borderRadius: radius.pill,
            backgroundColor: surface.iconButton,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon.gear size={ICON_GLYPH_SIZE} color={t.ink2} />
        </Pressable>
      </View>
    </View>
  );
}
