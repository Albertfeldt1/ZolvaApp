import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../useTheme';
import { Icon } from './Icon';

type Props = {
  eyebrow: string;
  onBell?: () => void;
  onGear?: () => void;
};

export function TopBar({ eyebrow, onBell, onGear }: Props) {
  const { t, type } = useTheme();
  const dark = t.mode === 'dark';
  const iconColor = dark ? 'rgba(255,255,255,0.7)' : t.ink2;
  const buttonBg = dark ? 'rgba(255,255,255,0.10)' : 'rgba(21,23,26,0.05)';

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 56,
        paddingHorizontal: 20,
      }}
    >
      <Text
        style={{
          fontSize: type.eyebrow.fontSize,
          lineHeight: type.eyebrow.lineHeight,
          letterSpacing: type.eyebrow.letterSpacing,
          fontFamily: type.eyebrow.fontFamily,
          textTransform: type.eyebrow.textTransform,
          color: dark ? 'rgba(255,255,255,0.65)' : t.ink3,
          fontWeight: '500',
        }}
      >
        {eyebrow}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={onBell}
          style={{
            width: 34,
            height: 34,
            borderRadius: 9999,
            backgroundColor: buttonBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon.bell size={16} color={iconColor} />
        </Pressable>
        <Pressable
          onPress={onGear}
          style={{
            width: 34,
            height: 34,
            borderRadius: 9999,
            backgroundColor: buttonBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon.gear size={16} color={iconColor} />
        </Pressable>
      </View>
    </View>
  );
}
