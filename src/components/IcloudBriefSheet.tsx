import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';

type Props = {
  visible: boolean;
  onClose: () => void;
  onConnectGmail: () => void;
};

export function IcloudBriefSheet({ visible, onClose, onConnectGmail }: Props) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View
        style={[
          styles.sheet,
          { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
        ]}
      >
        {/* Halo layer pinned to the sheet surface */}
        <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
          <GlassHaloLayer />
        </View>

        <ScrollView
          contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}
          showsVerticalScrollIndicator={false}
        >
          <GlassFrostedCard overlay={surface.bone} style={{ padding: spacing.xl, gap: spacing.lg }}>
            {/* Stone mascot */}
            <View style={{ alignItems: 'center' }}>
              <Stone size={48} jumpOnTap={false} />
            </View>

            {/* Headline */}
            <Text
              style={{
                fontFamily: fonts.display,
                fontSize: 20,
                lineHeight: 26,
                letterSpacing: -0.4,
                color: t.ink,
              }}
            >
              Hvorfor kræver morgenbrief Gmail eller Outlook?
            </Text>

            {/* Body copy */}
            <Text style={{ ...type.body, color: t.ink2, lineHeight: 22 }}>
              Apple tillader ikke den type baggrundsadgang vi har brug for til at sende dig en
              automatisk morgenbrief. Vi arbejder på en løsning.
            </Text>
            <Text style={{ ...type.body, color: t.ink2, lineHeight: 22 }}>
              Indtil da: forbind Gmail eller Outlook for at få morgenbriefen, eller brug
              Indbakke-skærmen for at se din iCloud-mail.
            </Text>

            {/* CTA - dark ink pill */}
            <Pressable
              style={{
                marginTop: spacing.xs,
                backgroundColor: t.ink,
                paddingVertical: 14,
                borderRadius: radius.soft,
                alignItems: 'center',
              }}
              onPress={() => { onClose(); onConnectGmail(); }}
              accessibilityRole="button"
            >
              <Text
                style={{ fontFamily: fonts.uiBold, fontSize: 15, color: surface.glassDarkText }}
              >
                Forbind Gmail
              </Text>
            </Pressable>

            {/* Ghost dismiss */}
            <Pressable
              style={{ paddingVertical: 12, alignItems: 'center' }}
              onPress={onClose}
              accessibilityRole="button"
            >
              <Text style={{ fontFamily: fonts.ui, fontSize: 14, color: t.ink3 }}>Annullér</Text>
            </Pressable>
          </GlassFrostedCard>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // Background sits behind the halo layer
    backgroundColor: '#FBFBFA',
    maxHeight: '75%',
    overflow: 'hidden',
  },
});
