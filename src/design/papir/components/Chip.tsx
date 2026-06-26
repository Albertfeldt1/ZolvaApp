import React from 'react';
import { ScaleButton } from '../../motion';
import { papirColor, papirRadius, papirSpace } from '../tokens';
import { PaperText } from './PaperText';

type Props = {
  label: string;
  active?: boolean;
  onPress?: () => void;
};

/** Pill chip. active = filled ink; otherwise hairline-bordered card. */
export function Chip({ label, active = false, onPress }: Props) {
  return (
    <ScaleButton
      scaleTo={0.975}
      haptic="selection"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: papirSpace.sm,
        paddingHorizontal: 14,
        borderRadius: papirRadius.pill,
        borderWidth: 1,
        borderColor: active ? papirColor.ink : papirColor.line,
        backgroundColor: active ? papirColor.ink : papirColor.card,
      }}
    >
      <PaperText role="chip" color={active ? papirColor.onInk : papirColor.ink2}>
        {label}
      </PaperText>
    </ScaleButton>
  );
}
