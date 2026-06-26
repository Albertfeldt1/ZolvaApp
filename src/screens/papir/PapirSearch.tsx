import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Search } from 'lucide-react-native';
import { Chip, ListRow, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { PushHeader } from './PushHeader';
import { WaveGlyph } from './WaveGlyph';

const FILTERS = ['Alt', 'Optagelser', 'Noter', 'Opgaver'];

const RESULTS = [
  { title: 'Aflevering til Ole', sub: 'Ring til Ole inden frokost', t: '9:41', bars: [5, 11, 7, 12] },
  { title: 'Tilbud til Hansen', sub: 'Pris på terrasse, send inden fredag', t: 'i går', bars: [9, 5, 13, 8] },
  { title: 'Møde med revisor', sub: 'Mangler bilag til moms', t: 'Man', bars: [7, 12, 5, 13] },
];

export function PapirSearch() {
  const [filter, setFilter] = useState(0);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Søg" />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          marginHorizontal: papirSpace.screen,
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderWidth: 1,
          borderColor: papirColor.line,
          borderRadius: papirRadius.lg,
          backgroundColor: papirColor.card,
        }}
      >
        <Search size={19} color={papirColor.ink3} strokeWidth={1.8} />
        <PaperText role="body" style={{ flex: 1 }}>
          Ole
        </PaperText>
        <View style={{ width: 2, height: 18, backgroundColor: papirColor.red }} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: papirSpace.screen, paddingTop: 18 }}
      >
        {FILTERS.map((f, i) => (
          <Chip key={f} label={f} active={i === filter} onPress={() => setFilter(i)} />
        ))}
      </ScrollView>

      <PaperText
        role="eyebrow"
        color={papirColor.ink3}
        style={{ paddingHorizontal: papirSpace.screen, paddingTop: 22, paddingBottom: 8 }}
      >
        {RESULTS.length} resultater
      </PaperText>
      {RESULTS.map((r, i) => (
        <View key={r.title}>
          <ListRow
            leading={<WaveGlyph heights={r.bars} color={papirColor.ink2} />}
            title={r.title}
            subtitle={r.sub}
            trailing={r.t}
          />
          {i < RESULTS.length - 1 ? (
            <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
