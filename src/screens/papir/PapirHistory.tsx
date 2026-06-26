import React from 'react';
import { ScrollView, View } from 'react-native';
import { ListRow, PaperText, papirColor, papirSpace } from '../../design/papir';
import { WaveGlyph } from './WaveGlyph';

function GroupLabel({ children }: { children: string }) {
  return (
    <PaperText
      role="eyebrow"
      color={papirColor.ink3}
      style={{ paddingHorizontal: papirSpace.screen, paddingTop: papirSpace.xl, paddingBottom: papirSpace.sm }}
    >
      {children}
    </PaperText>
  );
}

const GROUPS = [
  {
    label: 'I dag',
    items: [
      { title: 'Aflevering til Ole', sub: 'Mind mig om at ringe før frokost', t: '9:41', bars: [5, 11, 7, 13, 6] },
      { title: 'Indkøb til weekenden', sub: 'Mælk, kaffe, blomster til mor', t: '8:12', bars: [8, 13, 6, 10, 7] },
    ],
  },
  {
    label: 'I går',
    items: [
      { title: 'Tilbud til Hansen', sub: 'Pris på terrasse, send inden fredag', t: '16:02', bars: [9, 5, 13, 8, 11] },
      { title: 'Idéer til Instagram', sub: 'Reels om hverdagskaos', t: '11:30', bars: [6, 13, 9, 5, 12] },
    ],
  },
  {
    label: 'Tidligere',
    items: [
      { title: 'Møde med revisor', sub: 'Mangler bilag til moms, deadline 20.', t: 'Man', bars: [7, 12, 5, 13, 8] },
      { title: 'Tanker om navnet', sub: 'Kort, roligt, nemt at sige højt', t: 'Søn', bars: [10, 6, 13, 7, 9] },
    ],
  },
];

export function PapirHistory() {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingTop: 60, paddingBottom: 120 }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ paddingHorizontal: papirSpace.screen }}>
        <PaperText role="eyebrow" color={papirColor.ink3}>
          Alt du har sagt
        </PaperText>
        <PaperText role="displayM" style={{ marginTop: 8 }}>
          Historik
        </PaperText>
      </View>
      {GROUPS.map((g) => (
        <View key={g.label}>
          <GroupLabel>{g.label}</GroupLabel>
          {g.items.map((it, i) => (
            <View key={it.title}>
              <ListRow
                leading={<WaveGlyph heights={it.bars} color={papirColor.ink2} />}
                title={it.title}
                subtitle={it.sub}
                trailing={it.t}
              />
              {i < g.items.length - 1 ? (
                <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
              ) : null}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
