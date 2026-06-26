import React, { type ReactNode } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { ScaleButton } from '../../motion';
import { papirColor, papirRadius, papirSpace } from '../tokens';
import { PaperText } from './PaperText';

type Variant = 'primary' | 'ghost' | 'red';

const BG: Record<Variant, string> = {
  primary: papirColor.ink,
  ghost: papirColor.card,
  red: papirColor.red,
};
const FG: Record<Variant, string> = {
  primary: papirColor.onInk,
  ghost: papirColor.ink,
  red: '#FFFFFF',
};

type Props = {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  left?: ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Full-width-by-default action button. Variants: primary (ink), ghost, red. */
export function Button({ label, onPress, variant = 'primary', left, disabled, style }: Props) {
  return (
    <ScaleButton
      scaleTo={0.97}
      haptic="light"
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: papirSpace.sm,
          paddingVertical: papirSpace.base,
          paddingHorizontal: papirSpace.lg,
          borderRadius: papirRadius.lg,
          backgroundColor: BG[variant],
          opacity: disabled ? 0.5 : 1,
          ...(variant === 'ghost' ? { borderWidth: 1, borderColor: papirColor.line } : null),
        },
        style,
      ]}
    >
      {left}
      <PaperText role="button" color={FG[variant]}>
        {label}
      </PaperText>
    </ScaleButton>
  );
}
