import React from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { colors, fonts } from '../theme';
import { setPrivacyFlag } from '../lib/hooks';
import { migrateLocalChatIfNeeded } from '../lib/chat-sync';

type Props = {
  visible: boolean;
  userId: string;
  onClose: () => void;
};

// Renders as an Animated.View overlay (not a native <Modal>) because
// presentationStyle="pageSheet" race-conditions with WhatsNewModal /
// onboarding-backfill flow on first sign-in: iOS rejects two
// simultaneous modal transitions and leaves a phantom Modal that eats
// every touch on whatever screen lands behind it. Animated.View is a
// plain RN view so it stacks cleanly with everything else.
export function MemoryConsentModal({ visible, userId, onClose }: Props) {
  const enable = async () => {
    await setPrivacyFlag('memory-enabled', true);
    void migrateLocalChatIfNeeded(userId);
    onClose();
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={styles.absoluteFill}
      entering={SlideInDown.duration(320)}
      exiting={SlideOutDown.duration(260)}
    >
      <SafeAreaView style={styles.root}>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <Text style={styles.eyebrow}>Nyt</Text>
          <Text style={styles.title}>Zolva kan nu lære dig at kende</Text>
          <Text style={styles.p}>Med din tilladelse begynder Zolva at huske:</Text>
          <Text style={styles.bullet}>• Dine samtaler med Zolva.</Text>
          <Text style={styles.bullet}>• Hvem du mailer med (kun afsender og emnelinje, ikke indhold).</Text>
          <Text style={styles.bullet}>• Fakta du bekræfter, fx "Maria er min leder".</Text>
          <Text style={styles.p}>Det lever i din Zolva-konto — aldrig selve mail-indholdet.</Text>
          <Text style={styles.p}>Du kan altid slå det fra eller slette alt under Indstillinger → Hukommelse.</Text>
        </ScrollView>
        <View style={styles.footer}>
          <Pressable style={styles.secondary} onPress={onClose}><Text style={styles.secondaryText}>Ikke nu</Text></Pressable>
          <Pressable style={styles.primary} onPress={enable}><Text style={styles.primaryText}>Aktivér hukommelse</Text></Pressable>
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  absoluteFill: { ...StyleSheet.absoluteFillObject, zIndex: 100 },
  root: { flex: 1, backgroundColor: colors.paper },
  body: { padding: 24, gap: 12 },
  eyebrow: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.88, textTransform: 'uppercase', color: colors.sageDeep },
  title: { fontFamily: fonts.displayItalic, fontSize: 28, letterSpacing: -0.36, color: colors.ink },
  p: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.fg2 },
  bullet: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 22, color: colors.fg2 },
  footer: { flexDirection: 'row', gap: 12, padding: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  primary: { flex: 2, paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: colors.ink },
  primaryText: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.paper },
  secondary: { flex: 1, paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: colors.mist },
  secondaryText: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.fg2 },
});
