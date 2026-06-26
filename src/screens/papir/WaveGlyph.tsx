import React from 'react';
import { View } from 'react-native';
import { papirColor } from '../../design/papir';

type Props = {
  heights?: number[];
  color?: string;
  barWidth?: number;
};

/** Static mini-waveform glyph used as the leading icon on recording rows. */
export function WaveGlyph({ heights = [5, 11, 7, 13, 6], color = papirColor.ink3, barWidth = 2 }: Props) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1.5, height: 16 }}>
      {heights.map((h, i) => (
        <View key={i} style={{ width: barWidth, height: h, borderRadius: 2, backgroundColor: color }} />
      ))}
    </View>
  );
}
