import React, { type ReactNode } from 'react';
import { View } from 'react-native';
import { ScaleButton } from '../../motion';
import { papirColor, papirRadius, papirSpace } from '../tokens';
import { PaperText } from './PaperText';

type Props = {
  leading?: ReactNode; // icon/glyph rendered inside a 40pt paper2 box
  title: string;
  subtitle?: string;
  trailing?: string | ReactNode; // string → caption/ink3/tabular, else rendered as-is
  onPress?: () => void;
};

/** Generic list row: [leading box] title / subtitle … trailing. */
export function ListRow({ leading, title, subtitle, trailing, onPress }: Props) {
  return (
    <ScaleButton
      scaleTo={0.985}
      haptic="none"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingVertical: 15,
        paddingHorizontal: papirSpace.screen,
      }}
    >
      {leading ? (
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: papirRadius.sm + 2,
            backgroundColor: papirColor.paper2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {leading}
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <PaperText role="bodyStrong">{title}</PaperText>
        {subtitle ? (
          <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 3 }}>
            {subtitle}
          </PaperText>
        ) : null}
      </View>
      {typeof trailing === 'string' ? (
        <PaperText role="caption" color={papirColor.ink3} tabular>
          {trailing}
        </PaperText>
      ) : (
        (trailing ?? null)
      )}
    </ScaleButton>
  );
}
