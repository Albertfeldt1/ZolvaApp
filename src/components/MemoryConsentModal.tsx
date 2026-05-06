import React from 'react';
import { Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';
import { migrateLocalChatIfNeeded } from '../lib/chat-sync';
import { setPrivacyFlag } from '../lib/hooks';

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
  const { t, type, fonts, radius, spacing, surface } = useTheme();

  const enable = async () => {
    await setPrivacyFlag('memory-enabled', true);
    void migrateLocalChatIfNeeded(userId);
    onClose();
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={{ ...StyleSheet_absoluteFillObject, zIndex: 100 }}
      entering={SlideInDown.duration(320)}
      exiting={SlideOutDown.duration(260)}
    >
      <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
        <GlassHaloLayer />

        <SafeAreaView style={{ flex: 1 }}>
          <ScrollView
            contentContainerStyle={{
              flexGrow: 1,
              paddingHorizontal: spacing.screenPad,
              paddingTop: spacing.xl,
              paddingBottom: spacing.xl,
              gap: spacing.lg,
              justifyContent: 'center',
            }}
            showsVerticalScrollIndicator={false}
          >
            {/* Centered card */}
            <GlassFrostedCard
              overlay={surface.bone}
              style={{ padding: spacing.xl, gap: spacing.lg }}
            >
              {/* Stone header */}
              <View style={{ alignItems: 'center', paddingBottom: spacing.sm }}>
                <Stone size={72} jumpOnTap={false} />
              </View>

              {/* Eyebrow + headline */}
              <View style={{ gap: spacing.sm }}>
                <Text style={{ ...type.eyebrow, color: t.ink3 }}>Hukommelse</Text>
                <Text
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 26,
                    lineHeight: 30,
                    letterSpacing: -0.6,
                    color: t.ink,
                  }}
                >
                  Zolva kan nu lære dig at kende
                </Text>
              </View>

              {/* Body */}
              <View style={{ gap: spacing.md }}>
                <Text style={{ ...type.body, color: t.ink2 }}>
                  Med din tilladelse begynder Zolva at huske:
                </Text>
                <View style={{ gap: spacing.sm, paddingLeft: spacing.sm }}>
                  <Text style={{ ...type.body, color: t.ink2 }}>
                    · Dine samtaler med Zolva.
                  </Text>
                  <Text style={{ ...type.body, color: t.ink2 }}>
                    · Hvem du mailer med (kun afsender og emnelinje, ikke indhold).
                  </Text>
                  <Text style={{ ...type.body, color: t.ink2 }}>
                    · Fakta du bekræfter, fx "Maria er min leder".
                  </Text>
                </View>
                <Text style={{ ...type.bodySm, color: t.ink3 }}>
                  Det lever i din Zolva-konto — aldrig selve mail-indholdet.
                </Text>
                <Text style={{ ...type.bodySm, color: t.ink3 }}>
                  Du kan altid slå det fra eller slette alt under Indstillinger → Hukommelse.
                </Text>
              </View>

              {/* CTAs */}
              <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm }}>
                {/* Secondary — decline */}
                <Pressable
                  style={({ pressed }) => ({
                    flex: 1,
                    paddingVertical: spacing.md,
                    alignItems: 'center',
                    borderRadius: radius.pill,
                    backgroundColor: surface.glassWeak,
                    opacity: pressed ? 0.7 : 1,
                  })}
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Ikke nu"
                >
                  <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: t.ink2 }}>
                    Ikke nu
                  </Text>
                </Pressable>

                {/* Primary — accept */}
                <Pressable
                  style={({ pressed }) => ({
                    flex: 2,
                    paddingVertical: spacing.md,
                    alignItems: 'center',
                    borderRadius: radius.pill,
                    backgroundColor: t.ink,
                    opacity: pressed ? 0.8 : 1,
                  })}
                  onPress={enable}
                  accessibilityRole="button"
                  accessibilityLabel="Aktivér hukommelse"
                >
                  <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: t.paper }}>
                    Aktivér hukommelse
                  </Text>
                </Pressable>
              </View>
            </GlassFrostedCard>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Animated.View>
  );
}

// StyleSheet is not imported — use plain object spread for absoluteFillObject
const StyleSheet_absoluteFillObject = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};
