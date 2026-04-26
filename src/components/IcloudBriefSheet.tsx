import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  onConnectGmail: () => void;
};

export function IcloudBriefSheet({ visible, onClose, onConnectGmail }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.h1}>Hvorfor kræver morgenbrief Gmail eller Outlook?</Text>
          <Text style={styles.p}>
            Apple tillader ikke den type baggrundsadgang vi har brug for til at sende dig en automatisk morgenbrief. Vi arbejder på en løsning.
          </Text>
          <Text style={styles.p}>
            Indtil da: forbind Gmail eller Outlook for at få morgenbriefen, eller brug Indbakke-skærmen for at se din iCloud-mail.
          </Text>
          <Pressable
            style={styles.cta}
            onPress={() => { onClose(); onConnectGmail(); }}
            accessibilityRole="button"
          >
            <Text style={styles.ctaText}>Forbind Gmail</Text>
          </Pressable>
          <Pressable style={styles.dismiss} onPress={onClose} accessibilityRole="button">
            <Text style={styles.dismissText}>Luk</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.paper,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    maxHeight: '70%',
  },
  body: { padding: 24, gap: 16 },
  h1: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28, color: colors.ink },
  p: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.ink },
  cta: {
    marginTop: 16, backgroundColor: colors.ink,
    paddingVertical: 14, borderRadius: 8, alignItems: 'center',
  },
  ctaText: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.paper },
  dismiss: { paddingVertical: 12, alignItems: 'center' },
  dismissText: { fontFamily: fonts.ui, fontSize: 14, color: colors.fg3 },
});
