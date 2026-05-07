import { Moon, Sun, Sunrise } from 'lucide-react-native';
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
import { useBriefHistory } from '../lib/briefs';

type BriefKind = 'morning' | 'midday' | 'evening';

type Props = {
  kind: BriefKind | null;
  onClose: () => void;
  onSelect: (brief: Brief) => void;
};

export function BriefHistoryModal({ kind, onClose, onSelect }: Props) {
  // Cache the last non-null kind so the slide-down close animation has
  // content to render. Without this, kind flips to null synchronously
  // and the inner View becomes null while iOS is still animating —
  // result: the modal vanishes instantly instead of sliding down.
  const [shownKind, setShownKind] = useState<BriefKind | null>(kind);
  useEffect(() => {
    if (kind) setShownKind(kind);
  }, [kind]);
  return (
    <Modal
      visible={kind !== null}
      animationType="slide"
      presentationStyle="overFullScreen"
      transparent
      onRequestClose={onClose}
    >
      {shownKind !== null ? (
        <BriefHistoryContent kind={shownKind} onClose={onClose} onSelect={onSelect} />
      ) : null}
    </Modal>
  );
}

function BriefHistoryContent({
  kind,
  onClose,
  onSelect,
}: {
  kind: BriefKind;
  onClose: () => void;
  onSelect: (brief: Brief) => void;
}) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const { items, loading } = useBriefHistory(kind);

  const KindIcon = kind === 'evening' ? Moon : kind === 'midday' ? Sun : Sunrise;
  const title =
    kind === 'evening'
      ? 'Aftenbriefs'
      : kind === 'midday'
      ? 'Middagsbriefs'
      : 'Morgenbriefs';
  const today = new Date();
  const emptyLabel =
    kind === 'evening'
      ? 'aftenbriefs'
      : kind === 'midday'
      ? 'middagsbriefs'
      : 'morgenbriefs';

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
            <KindIcon size={18} color={t.ink2} strokeWidth={1.75} />
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
                {title}
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
              Ingen {emptyLabel} endnu.
            </Text>
          </GlassFrostedCard>
        ) : (
          <GlassFrostedCard overlay={surface.bone} style={{ paddingVertical: 0, paddingHorizontal: spacing.lg }}>
            {items.map((b, i) => (
              <Pressable
                key={b.id}
                onPress={() => onSelect(b)}
                style={[
                  {
                    paddingVertical: spacing.md,
                  },
                  i > 0 && {
                    borderTopWidth: 1,
                    borderTopColor: t.line,
                  },
                ]}
              >
                <Text
                  style={{
                    ...type.eyebrow,
                    color: t.ink3,
                    marginBottom: spacing.xs,
                  }}
                >
                  {formatBriefDate(b.generatedAt, today)}
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 20,
                    lineHeight: 26,
                    letterSpacing: -0.4,
                    color: t.ink,
                  }}
                  numberOfLines={2}
                >
                  {b.headline}
                </Text>
              </Pressable>
            ))}
          </GlassFrostedCard>
        )}
      </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const DANISH_MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'maj', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
];

function formatBriefDate(d: Date, today: Date): string {
  if (sameDay(d, today)) return 'I dag';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return 'I går';
  const day = d.getDate();
  const month = DANISH_MONTHS[d.getMonth()];
  const yearSuffix = d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${day}. ${month}${yearSuffix}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
