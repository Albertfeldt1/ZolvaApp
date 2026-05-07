import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { useTheme } from '../design/useTheme';
import type { Brief } from '../lib/briefs';

type Props = {
  brief: Brief | null;
  visible: boolean;
  onClose: () => void;
};

export function BriefModal({ brief, visible, onClose }: Props) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();

  // Hold onto the last non-null brief so the slide-down close animation
  // still has content to render. Without this, the parent nulls `brief`
  // synchronously when closing, the inner View renders empty, and the
  // iOS pageSheet visibly flashes white during the ~250 ms slide-out.
  const [shownBrief, setShownBrief] = useState<Brief | null>(brief);
  useEffect(() => {
    if (brief) setShownBrief(brief);
  }, [brief]);

  const weatherLine = shownBrief?.weather
    ? `${shownBrief.weather.tempC.toFixed(0)}°C · ${shownBrief.weather.conditionLabel}`
    : null;

  const kindLabel =
    shownBrief?.kind === 'morning'
      ? 'Morgenbrief'
      : shownBrief?.kind === 'midday'
      ? 'Middagsbrief'
      : 'Aftenbrief';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="overFullScreen"
      transparent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
        <GlassHaloLayer />
        <SafeAreaView style={{ flex: 1 }}>

        {/* Header */}
        <View
          style={{
            paddingTop: spacing.sm,
            paddingHorizontal: spacing.screenPad,
            paddingBottom: spacing.md,
            position: 'relative',
            zIndex: 1,
          }}
        >
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Pressable
                onPress={onClose}
                hitSlop={8}
                accessibilityLabel="Luk brief"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: radius.pill,
                  backgroundColor: surface.iconButton,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontFamily: fonts.ui, fontSize: 18, color: t.ink2 }}>×</Text>
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 20,
                    fontWeight: '600',
                    letterSpacing: -0.4,
                    color: t.ink,
                  }}
                >
                  {kindLabel}
                </Text>
                {weatherLine && (
                  <Text style={{ ...type.eyebrow, color: t.ink3, textTransform: 'none' }}>
                    {weatherLine}
                  </Text>
                )}
              </View>
            </View>
          </GlassFrostedCard>
        </View>

        {/* Body */}
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: spacing.screenPad,
            paddingBottom: spacing.xxl,
          }}
          showsVerticalScrollIndicator={false}
        >
          {shownBrief && (
            <GlassFrostedCard
              overlay={surface.bone}
              style={{ padding: spacing.lg }}
            >
              <Text
                style={{
                  fontFamily: fonts.display,
                  fontSize: 28,
                  lineHeight: 34,
                  letterSpacing: -0.5,
                  color: t.ink,
                }}
              >
                {shownBrief.headline}
              </Text>
              <View
                style={{
                  marginTop: spacing.md,
                  marginBottom: spacing.md,
                  height: 1,
                  backgroundColor: t.line,
                }}
              />
              {shownBrief.body.map((line, i) => (
                <Text
                  key={i}
                  style={{
                    ...type.body,
                    color: t.ink2,
                    marginBottom: spacing.md,
                  }}
                >
                  {line}
                </Text>
              ))}
            </GlassFrostedCard>
          )}
        </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
