import React from 'react';
import { Mic } from 'lucide-react-native';
import { ScaleButton } from '../../motion';
import { papirColor, papirRadius, papirShadow } from '../tokens';

type Props = { onPress?: () => void };

/** The signature center record button — terracotta circle + warm red shadow. */
export function RecordFAB({ onPress }: Props) {
  return (
    <ScaleButton
      scaleTo={0.9}
      haptic="medium"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Optag"
      style={[
        {
          width: 60,
          height: 60,
          borderRadius: papirRadius.pill,
          backgroundColor: papirColor.red,
          alignItems: 'center',
          justifyContent: 'center',
        },
        papirShadow.red,
      ]}
    >
      <Mic size={25} color="#FFFFFF" strokeWidth={1.9} />
    </ScaleButton>
  );
}
