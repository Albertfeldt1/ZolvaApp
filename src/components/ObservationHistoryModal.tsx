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
import type { SurfaceTokens } from '../design/theme';
import { useTheme } from '../design/useTheme';
import { useObservationHistory } from '../lib/hooks';
import type { StoredObservation } from '../lib/hooks';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function ObservationHistoryModal({ visible, onClose }: Props) {
  // Latch to true on first open and stay true until the modal closes —
  // gives the slide-down animation content to render. Without this,
  // visible flips false and the inner View disappears immediately.
  const [everShown, setEverShown] = useState(false);
  useEffect(() => {
    if (visible) setEverShown(true);
  }, [visible]);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="overFullScreen"
      transparent
      onRequestClose={onClose}
    >
      {everShown ? <ObservationHistoryContent onClose={onClose} /> : null}
    </Modal>
  );
}

function ObservationHistoryContent({ onClose }: { onClose: () => void }) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const { items, loading } = useObservationHistory();
  const today = new Date();

  return (
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
              accessibilityLabel="Luk"
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
                Bemærket
              </Text>
            </View>
          </View>
        </GlassFrostedCard>
      </View>

      {/* List */}
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: spacing.screenPad,
          paddingBottom: spacing.xxl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {items.length === 0 && !loading ? (
          <GlassFrostedCard overlay={surface.bone} style={{ padding: spacing.lg }}>
            <Text
              style={{
                ...type.body,
                color: t.ink3,
                textAlign: 'center',
              }}
            >
              Ingen tidligere observationer endnu.
            </Text>
          </GlassFrostedCard>
        ) : (
          <View style={{ gap: spacing.md }}>
            {(() => {
              let lastDate: string | null = null;
              return items.map((o, i) => {
                const showDate = o.sourceDate !== lastDate;
                lastDate = o.sourceDate;
                return (
                  <React.Fragment key={o.id}>
                    {showDate && (
                      <Text
                        style={{
                          ...type.eyebrow,
                          color: t.ink3,
                          paddingTop: i > 0 ? spacing.sm : 0,
                        }}
                      >
                        {formatSourceDate(o.sourceDate, today)}
                      </Text>
                    )}
                    <GlassFrostedCard
                      overlay={surface.bone}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'flex-start',
                        gap: spacing.md,
                        padding: spacing.md,
                      }}
                    >
                      <View
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 999,
                          marginTop: 7,
                          backgroundColor: moodDotColor(o, surface),
                        }}
                      />
                      <Text
                        style={{
                          flex: 1,
                          ...type.body,
                          color: t.ink,
                        }}
                      >
                        {o.text}
                      </Text>
                    </GlassFrostedCard>
                  </React.Fragment>
                );
              });
            })()}
          </View>
        )}
      </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function moodDotColor(o: StoredObservation, surface: SurfaceTokens): string {
  if (o.mood === 'happy') return surface.successText;  // green — positive observation
  if (o.mood === 'thinking') return '#C17A5B';          // clay amber — requires a decision
  return 'rgba(120,122,130,0.6)';                       // neutral grey — calm observation
}

const DANISH_MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'maj', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
];

function formatSourceDate(sourceDate: string, today: Date): string {
  const [y, m, d] = sourceDate.split('-').map((s) => Number(s));
  if (!y || !m || !d) return sourceDate;
  const dateObj = new Date(y, m - 1, d);
  if (sameDay(dateObj, today)) return 'I dag';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(dateObj, yesterday)) return 'I går';
  const yearSuffix = dateObj.getFullYear() !== today.getFullYear() ? ` ${dateObj.getFullYear()}` : '';
  return `${dateObj.getDate()}. ${DANISH_MONTHS[dateObj.getMonth()]}${yearSuffix}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
