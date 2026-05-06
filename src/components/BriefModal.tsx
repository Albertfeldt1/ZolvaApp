import React from 'react';
import {
  Modal,
  Pressable,
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

  const weatherLine = brief?.weather
    ? `${brief.weather.tempC.toFixed(0)}°C · ${brief.weather.conditionLabel}`
    : null;

  const kindLabel =
    brief?.kind === 'morning'
      ? 'Morgenbrief'
      : brief?.kind === 'midday'
      ? 'Middagsbrief'
      : 'Aftenbrief';

  return (
    <Modal
      visible={visible && !!brief}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
        <GlassHaloLayer />

        {/* Header */}
        <View
          style={{
            paddingTop: spacing.lg,
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
          {brief && (
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
                {brief.headline}
              </Text>
              <View
                style={{
                  marginTop: spacing.md,
                  marginBottom: spacing.md,
                  height: 1,
                  backgroundColor: t.line,
                }}
              />
              {brief.body.map((line, i) => (
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
      </View>
    </Modal>
  );
}
