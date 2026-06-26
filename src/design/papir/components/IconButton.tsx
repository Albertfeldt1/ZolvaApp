import React, { type ReactNode } from 'react';
import { ScaleButton } from '../../motion';
import { papirColor, papirRadius } from '../tokens';

type Props = {
  children: ReactNode; // a lucide icon
  onPress?: () => void;
  accessibilityLabel?: string;
};

/** 38pt circular icon button with hairline border (press scale 0.90). */
export function IconButton({ children, onPress, accessibilityLabel }: Props) {
  return (
    <ScaleButton
      scaleTo={0.9}
      haptic="light"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: 38,
        height: 38,
        borderRadius: papirRadius.pill,
        borderWidth: 1,
        borderColor: papirColor.line,
        backgroundColor: papirColor.card,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </ScaleButton>
  );
}
