import React from 'react';
import { ScrollView, View } from 'react-native';
import { ArrowRight } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Chip, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { PushHeader } from './PushHeader';

function ZolvaMsg({ children }: { children: string }) {
  return (
    <View style={{ maxWidth: '84%', alignSelf: 'flex-start' }}>
      <PaperText role="eyebrow" color={papirColor.ink3} style={{ marginBottom: 6 }}>
        Zolva
      </PaperText>
      <PaperText role="body">{children}</PaperText>
    </View>
  );
}

function MeMsg({ children }: { children: string }) {
  return (
    <View
      style={{
        maxWidth: '84%',
        alignSelf: 'flex-end',
        backgroundColor: papirColor.ink,
        paddingVertical: 12,
        paddingHorizontal: 15,
        borderRadius: 18,
        borderBottomRightRadius: 5,
      }}
    >
      <PaperText role="body" color={papirColor.onInk}>
        {children}
      </PaperText>
    </View>
  );
}

export function PapirChat() {
  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
      <PushHeader
        title="Zolva"
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: papirColor.green }} />
            <PaperText role="caption" color={papirColor.green}>
              Online
            </PaperText>
          </View>
        }
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: papirSpace.screen, paddingTop: 6, paddingBottom: 12, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <ZolvaMsg>Godmorgen Oscar. Du har 1 møde og 9 mails i dag. Skal jeg samle det vigtigste?</ZolvaMsg>
        <MeMsg>Ja tak. Og hvornår skal jeg aflevere dyrene til Ole?</MeMsg>
        <ZolvaMsg>Kl. 13.55 i dag, 2 stk. Skal jeg minde dig om det 30 minutter før?</ZolvaMsg>
        <View
          style={{
            alignSelf: 'flex-start',
            width: '84%',
            borderWidth: 1,
            borderColor: papirColor.line,
            borderRadius: 16,
            padding: 13,
            backgroundColor: papirColor.card,
          }}
        >
          <PaperText role="bodyStrong">Påmindelse · 13.25</PaperText>
          <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 3 }}>
            Aflever 2 dyr til Ole
          </PaperText>
          <ScaleButton
            scaleTo={0.95}
            haptic="light"
            style={{
              alignSelf: 'flex-start',
              marginTop: 11,
              backgroundColor: papirColor.red,
              paddingVertical: 8,
              paddingHorizontal: 16,
              borderRadius: papirRadius.pill,
            }}
          >
            <PaperText role="small" color="#FFFFFF">
              Tilføj
            </PaperText>
          </ScaleButton>
        </View>
        <MeMsg>Perfekt. Hvad haster mest i indbakken?</MeMsg>
        <ZolvaMsg>
          Tilbuddet til Hansen. Det skal sendes inden fredag, og han har spurgt to gange. Vil du diktere svaret nu?
        </ZolvaMsg>
      </ScrollView>

      {/* Composer */}
      <View style={{ paddingHorizontal: papirSpace.screen, paddingTop: 12, paddingBottom: 28, gap: 12 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label="Hvad haster?" />
          <Chip label="Skriv en note" />
          <Chip label="Saml dagens mails" />
        </ScrollView>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: papirColor.card,
            borderWidth: 1,
            borderColor: papirColor.line,
            borderRadius: papirRadius.pill,
            paddingVertical: 6,
            paddingLeft: 18,
            paddingRight: 6,
          }}
        >
          <PaperText role="body" color={papirColor.ink3} style={{ flex: 1 }}>
            Spørg Zolva
          </PaperText>
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: papirColor.ink,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ArrowRight size={17} color={papirColor.onInk} strokeWidth={2} />
          </View>
        </View>
      </View>
    </View>
  );
}
