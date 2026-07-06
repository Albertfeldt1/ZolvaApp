import React from 'react';
import { View } from 'react-native';
import { PaperText, papirColor } from '../../design/papir';

/** Category accent duos for content tags — deep text on its soft surface.
 * From the approved Claude-design exploration: voice notes are red (the
 * app's "spoken" color), plain notes slate, events/agreements green. */
export const papirTagKinds = {
  talenote: { color: papirColor.red, bg: papirColor.redSoft },
  note: { color: papirColor.slate, bg: papirColor.slateSoft },
  event: { color: papirColor.green, bg: papirColor.greenSoft },
  neutral: { color: papirColor.ink2, bg: papirColor.paper2 },
} as const;

export type PapirTagKind = keyof typeof papirTagKinds;

/** Small uppercase category pill ("TALENOTE", "NOTE", …). */
export function PapirTag({ label, kind }: { label: string; kind: PapirTagKind }) {
  const { color, bg } = papirTagKinds[kind];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: bg,
        borderRadius: 999,
        paddingVertical: 2.5,
        paddingHorizontal: 8,
      }}
    >
      <PaperText
        role="caption"
        color={color}
        style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' }}
      >
        {label}
      </PaperText>
    </View>
  );
}
