import React, { type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { ArrowRight } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirSpace } from '../../design/papir';
import { usePapirNav } from './nav';
import { PushHeader } from './PushHeader';

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen, marginTop: 24 }} />
      <View style={{ paddingHorizontal: papirSpace.screen, paddingTop: 22 }}>
        <PaperText role="eyebrow" color={papirColor.red}>
          {label}
        </PaperText>
        <View style={{ marginTop: 10 }}>{children}</View>
      </View>
    </>
  );
}

const PLAN: [string, string][] = [
  ['11.00', 'Kundemøde hos Hansen'],
  ['13.55', 'Aflever 2 dyr til Ole'],
  ['16.30', 'Opkald med revisor'],
];

export function PapirBriefing() {
  const nav = usePapirNav();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Briefing" />
      <View style={{ paddingHorizontal: papirSpace.screen }}>
        <PaperText role="eyebrow" color={papirColor.ink3}>
          Tirsdag · 11. juni · 9:41
        </PaperText>
        <PaperText role="displayM" style={{ marginTop: 12 }}>
          Godmorgen,{'\n'}her er din dag.
        </PaperText>
        <PaperText role="bodySerif" color={papirColor.ink2} style={{ marginTop: 20 }}>
          Roligt program i dag. Ét møde, lidt i indbakken, og en aflevering du ikke må glemme. Jeg har lagt det
          vigtigste øverst.
        </PaperText>
      </View>

      <Section label="Vejret">
        <PaperText role="body" color={papirColor.ink2}>
          14° og overskyet i Næstved. Lidt regn omkring frokost, så tag jakken med til Ole.
        </PaperText>
      </Section>

      <Section label="Dagens plan">
        {PLAN.map(([t, title]) => (
          <View key={t} style={{ flexDirection: 'row', gap: 14, paddingVertical: 10 }}>
            <PaperText role="small" color={papirColor.ink3} tabular style={{ width: 42 }}>
              {t}
            </PaperText>
            <PaperText role="body" style={{ flex: 1 }}>
              {title}
            </PaperText>
          </View>
        ))}
      </Section>

      <Section label="Indbakke">
        <ScaleButton scaleTo={0.99} haptic="light" onPress={() => nav.push('inbox')}>
          <PaperText role="body" color={papirColor.ink2}>
            <PaperText role="bodyStrong" color={papirColor.ink}>
              3 mails kræver svar
            </PaperText>{' '}
            i dag: Ole om aflevering, Hansen om tilbud, og revisoren om bilag. Resten kan vente.
          </PaperText>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <PaperText role="small" color={papirColor.red}>
              Åbn indbakke
            </PaperText>
            <ArrowRight size={14} color={papirColor.red} strokeWidth={2} />
          </View>
        </ScaleButton>
      </Section>

      <Section label="At huske">
        <PaperText role="bodySerif" style={{ fontSize: 19, lineHeight: 28 }}>
          Du ville sende tilbuddet til Hansen inden fredag. Det ligger nu øverst på din liste.
        </PaperText>
      </Section>
    </ScrollView>
  );
}
