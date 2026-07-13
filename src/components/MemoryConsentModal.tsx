import React from 'react';
import { Alert, SafeAreaView, ScrollView, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { Mail, MessageSquare, Sparkles } from 'lucide-react-native';
import { DURATION } from '../design/motion';
import {
  BreathingWave,
  Button,
  PaperText,
  papirColor,
  papirFont,
  papirRadius,
  papirSpace,
} from '../design/papir';
import { migrateLocalChatIfNeeded } from '../lib/chat-sync';
import { setPrivacyFlag } from '../lib/hooks';
import { syncMemoryEnabled } from '../lib/user-profile';

type Props = {
  visible: boolean;
  userId: string;
  onClose: () => void;
};

/** Hvad Zolva husker — tre stille ikonlinjer, samme motiv som Titelbladets
 * capability-liste, så samtykket føles som en fortsættelse af login-flowet. */
const REMEMBERS = [
  { Icon: MessageSquare, text: 'Dine samtaler med Zolva' },
  { Icon: Mail, text: 'Hvem du mailer med — kun afsender og emne, aldrig indholdet' },
  { Icon: Sparkles, text: 'Fakta du bekræfter, fx "Maria er min leder"' },
] as const;

// Renders as an Animated.View overlay (not a native <Modal>) because
// presentationStyle="pageSheet" race-conditions with WhatsNewModal /
// onboarding-backfill flow on first sign-in: iOS rejects two
// simultaneous modal transitions and leaves a phantom Modal that eats
// every touch on whatever screen lands behind it. Animated.View is a
// plain RN view so it stacks cleanly with everything else.
export function MemoryConsentModal({ visible, userId, onClose }: Props) {
  const enable = async () => {
    // Optimistic local flip mirrors the Memory-screen toggle. The
    // consent flow's failure mode is the inverse privacy bug: user
    // explicitly consented but the server gate stayed `false`, so cron
    // and chat-run keep skipping memory features the user just opted in
    // to. Same shape as the toggle revert path — flip locally, mirror
    // to server, revert on failure with a network-attributed alert.
    await setPrivacyFlag('memory-enabled', true);
    void migrateLocalChatIfNeeded(userId);
    try {
      await syncMemoryEnabled(userId, true);
    } catch (err) {
      if (__DEV__) console.warn('[MemoryConsentModal] memory_enabled sync failed:', err);
      await setPrivacyFlag('memory-enabled', false);
      Alert.alert(
        'Kunne ikke gemme indstillingen',
        'Tjek din forbindelse og prøv igen.',
      );
      return;
    }
    onClose();
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={{ ...absoluteFill, zIndex: 100 }}
      // Spring entrance (matches SPRING_GENTLE) so the sheet settles in like a
      // native iOS sheet rather than sliding a fixed 320ms. Exit stays a brisk
      // timed slide — exits should feel quicker than entrances.
      entering={SlideInDown.springify().damping(20).stiffness(180).mass(0.9)}
      exiting={SlideOutDown.duration(DURATION.modalExit)}
    >
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <SafeAreaView style={{ flex: 1 }}>
          <ScrollView
            contentContainerStyle={{
              flexGrow: 1,
              paddingHorizontal: papirSpace.screen,
              paddingVertical: papirSpace.xl,
              justifyContent: 'center',
            }}
            showsVerticalScrollIndicator={false}
          >
            <View
              style={{
                backgroundColor: papirColor.card,
                borderWidth: 1,
                borderColor: papirColor.line,
                borderRadius: papirRadius.xl,
                padding: papirSpace.xl,
                gap: papirSpace.lg,
              }}
            >
              {/* Bølgen er brand-tråden fra Titelbladet — samtykket skal føles
                  som næste side i samme bog, ikke et systemvindue. */}
              <View style={{ alignItems: 'flex-start' }}>
                <BreathingWave />
              </View>

              <View style={{ gap: papirSpace.xs }}>
                <PaperText role="eyebrow" color={papirColor.ink3}>
                  Hukommelse
                </PaperText>
                <PaperText
                  accessibilityRole="header"
                  style={{
                    fontFamily: papirFont.displayLight,
                    fontSize: 30,
                    lineHeight: 36,
                    letterSpacing: -0.5,
                    color: papirColor.ink,
                  }}
                >
                  Må Zolva lære dig at kende?
                </PaperText>
              </View>

              <PaperText role="bodySerif" color={papirColor.ink2}>
                Med din tilladelse begynder Zolva at huske:
              </PaperText>

              <View style={{ gap: papirSpace.md }}>
                {REMEMBERS.map(({ Icon, text }) => (
                  <View
                    key={text}
                    style={{ flexDirection: 'row', alignItems: 'flex-start', gap: papirSpace.sm }}
                  >
                    <Icon
                      size={15}
                      color={papirColor.ink3}
                      strokeWidth={1.8}
                      style={{ marginTop: 3 }}
                    />
                    <PaperText role="body" color={papirColor.ink2} style={{ flex: 1 }}>
                      {text}
                    </PaperText>
                  </View>
                ))}
              </View>

              <View style={{ gap: papirSpace.xs }}>
                <PaperText role="caption" color={papirColor.ink3}>
                  Det lever i din Zolva-konto — aldrig selve mail-indholdet.
                </PaperText>
                <PaperText role="caption" color={papirColor.ink3}>
                  Du kan altid slå det fra eller slette alt under Indstillinger → Hukommelse.
                </PaperText>
              </View>

              {/* Stablet, så begge labels altid har plads — den gamle række
                  klippede "Aktivér hukommelse" på smalle skærme. */}
              <View style={{ gap: papirSpace.sm, marginTop: papirSpace.xs }}>
                <Button label="Aktivér hukommelse" variant="primary" onPress={() => void enable()} />
                <Button label="Ikke nu" variant="ghost" onPress={onClose} />
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Animated.View>
  );
}

const absoluteFill = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};
