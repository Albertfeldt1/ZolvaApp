import React from 'react';
import { Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';

// Bump this when a release ships notable user-visible changes worth a
// fresh modal. The per-uid flag is keyed on this version, so users who
// already saw an older version's modal still get re-prompted.
export const WHATS_NEW_VERSION = 'v3';

type Props = {
  visible: boolean;
  onClose: () => void;
};

// Animated.View overlay (not <Modal>) - see MemoryConsentModal.tsx for the
// rationale; same iOS modal-stacking conflict applies here.
export function WhatsNewModal({ visible, onClose }: Props) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();

  if (!visible) return null;

  return (
    <Animated.View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }}
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
            }}
            showsVerticalScrollIndicator={false}
          >
            {/* Content card */}
            <GlassFrostedCard
              overlay={surface.bone}
              style={{ padding: spacing.xl, gap: spacing.lg }}
            >
              {/* Stone header */}
              <View style={{ alignItems: 'center', paddingBottom: spacing.sm }}>
                <Stone size={72} jumpOnTap={false} />
              </View>

              {/* Version eyebrow + headline */}
              <View style={{ gap: spacing.sm }}>
                <Text style={{ ...type.eyebrow, color: t.ink3 }}>VERSION {WHATS_NEW_VERSION.toUpperCase()}</Text>
                <Text
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 26,
                    lineHeight: 30,
                    letterSpacing: -0.6,
                    color: t.ink,
                  }}
                >
                  Lille opdatering
                </Text>
              </View>

              {/* Body */}
              <View style={{ gap: spacing.md }}>
                <Text style={{ ...type.body, color: t.ink, fontFamily: fonts.uiBold }}>
                  Et par ting jeg kan nu:
                </Text>

                <Text style={{ ...type.body, color: t.ink2, lineHeight: 22 }}>
                  Du kan sige til Siri: "Hey Siri, Zolva husk mig på at ringe mor kl. 17" -
                  så har du en påmindelse.
                </Text>

                <Text style={{ ...type.body, color: t.ink2, lineHeight: 22 }}>
                  Påmindelser fyrer pålideligt nu, også når du har lukket mig. Det var
                  lidt vakkelvornt før.
                </Text>

                <Text style={{ ...type.body, color: t.ink2, lineHeight: 22 }}>
                  iCloud-mail virker igen - hvis du fik "Kunne ikke hente indbakke", er
                  det forbi.
                </Text>

                <Text style={{ ...type.body, color: t.ink2, lineHeight: 22 }}>
                  Sidste ting: hvis Zolva beder dig om at logge ind én gang lige nu, er
                  det fordi jeg har skiftet til en ny måde at holde din forbindelse til
                  Google/Microsoft i live på. Bagefter holder den sig selv kørende - du
                  burde ikke se den boks igen.
                </Text>
              </View>

              {/* Primary CTA */}
              <Pressable
                style={({ pressed }) => ({
                  paddingVertical: spacing.md + 2,
                  alignItems: 'center',
                  borderRadius: radius.pill,
                  backgroundColor: t.ink,
                  marginTop: spacing.sm,
                  opacity: pressed ? 0.8 : 1,
                })}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Forstået"
              >
                <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: t.paper }}>
                  Forstået
                </Text>
              </Pressable>
            </GlassFrostedCard>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Animated.View>
  );
}
