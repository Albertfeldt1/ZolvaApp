import React from 'react';
import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

// Bump this when a release ships notable user-visible changes worth a
// fresh modal. The per-uid flag is keyed on this version, so users who
// already saw an older version's modal still get re-prompted.
export const WHATS_NEW_VERSION = 'v3';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function WhatsNewModal({ visible, onClose }: Props) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <Text style={styles.eyebrow}>Nyt</Text>
          <Text style={styles.title}>Lille opdatering</Text>

          <Text style={styles.lead}>Et par ting jeg kan nu:</Text>

          <Text style={styles.p}>
            Du kan sige til Siri: "Hey Siri, Zolva husk mig på at ringe mor kl. 17" —
            så har du en påmindelse.
          </Text>

          <Text style={styles.p}>
            Påmindelser fyrer pålideligt nu, også når du har lukket mig. Det var
            lidt vakkelvornt før.
          </Text>

          <Text style={styles.p}>
            iCloud-mail virker igen — hvis du fik "Kunne ikke hente indbakke", er
            det forbi.
          </Text>

          <Text style={styles.p}>
            Sidste ting: hvis Zolva beder dig om at logge ind én gang lige nu, er
            det fordi jeg har skiftet til en ny måde at holde din forbindelse til
            Google/Microsoft i live på. Bagefter holder den sig selv kørende — du
            burde ikke se den boks igen.
          </Text>
        </ScrollView>
        <View style={styles.footer}>
          <Pressable style={styles.primary} onPress={onClose}>
            <Text style={styles.primaryText}>Forstået</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  body: { padding: 24, gap: 14 },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  title: {
    fontFamily: fonts.displayItalic,
    fontSize: 28,
    letterSpacing: -0.36,
    color: colors.ink,
  },
  lead: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.ink, marginTop: 4 },
  p: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.fg2 },
  footer: {
    padding: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  primary: { paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: colors.ink },
  primaryText: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.paper },
});
