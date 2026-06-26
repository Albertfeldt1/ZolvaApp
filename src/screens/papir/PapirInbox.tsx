import React from 'react';
import { ScrollView, View } from 'react-native';
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { PushHeader } from './PushHeader';

const MAILS = [
  { from: 'Ole Hansen', subj: 'Aflevering i dag?', preview: 'Hej, passer det stadig at du kommer forbi…', t: '9:12', urgent: true, initial: 'O' },
  { from: 'Hansen Byg', subj: 'Tilbud på terrasse', preview: 'Vi mangler stadig prisen på det store…', t: '8:40', urgent: true, initial: 'H' },
  { from: 'Revisor Berg', subj: 'Bilag til moms', preview: 'Deadline er den 20. — kan du nå at sende…', t: 'i går', urgent: true, initial: 'R' },
  { from: 'Leverandør', subj: 'Ordrebekræftelse #4471', preview: 'Tak for din ordre. Forventet levering…', t: 'i går', urgent: false, initial: 'L' },
  { from: 'Nyhedsbrev', subj: 'Ugens tilbud til erhverv', preview: 'Se hvad vi har på lager denne uge…', t: 'man', urgent: false, initial: 'N' },
];

export function PapirInbox() {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Indbakke" />
      <PaperText
        role="eyebrow"
        color={papirColor.red}
        style={{ paddingHorizontal: papirSpace.screen, paddingBottom: 8 }}
      >
        3 kræver svar
      </PaperText>
      {MAILS.map((m, i) => (
        <View key={m.from}>
          <ScaleButton
            scaleTo={0.99}
            haptic="none"
            accessibilityRole="button"
            accessibilityLabel={`${m.from}: ${m.subj}`}
            style={{
              flexDirection: 'row',
              gap: 14,
              alignItems: 'flex-start',
              paddingHorizontal: papirSpace.screen,
              paddingVertical: 14,
            }}
          >
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
              <PaperText role="bodyStrong" color={papirColor.ink2}>
                {m.initial}
              </PaperText>
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {m.urgent ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: papirColor.red }} /> : null}
                <PaperText role="bodyStrong" style={{ flex: 1 }}>
                  {m.from}
                </PaperText>
                <PaperText role="caption" color={papirColor.ink4}>
                  {m.t}
                </PaperText>
              </View>
              <PaperText role="body" style={{ marginTop: 2 }}>
                {m.subj}
              </PaperText>
              <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 2 }} numberOfLines={1}>
                {m.preview}
              </PaperText>
            </View>
          </ScaleButton>
          {i < MAILS.length - 1 ? (
            <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
