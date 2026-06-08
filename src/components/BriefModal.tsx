import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  View,
} from 'react-native';
import {
  Calendar as CalendarIcon,
  CheckCircle2,
  Cloud,
  Lightbulb,
  Mail,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { useTheme } from '../design/useTheme';
import type { Brief } from '../lib/briefs';

type Props = {
  brief: Brief | null;
  visible: boolean;
  onClose: () => void;
};

// "Torsdag 15. maj – din arbejdsdag i overblik". Date comes from the brief's
// generation time; the trailing phrase is fixed per kind. Built piecewise (not
// via a single Intl pattern) so the weekday is capitalised and "den" is dropped
// to match the design.
function modalTitle(brief: Brief): string {
  const d = brief.generatedAt;
  const weekday = new Intl.DateTimeFormat('da-DK', { weekday: 'long' }).format(d);
  const month = new Intl.DateTimeFormat('da-DK', { month: 'long' }).format(d);
  const cap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const phrase =
    brief.kind === 'morning'
      ? 'din arbejdsdag i overblik'
      : brief.kind === 'midday'
      ? 'din eftermiddag i overblik'
      : 'din aften i overblik';
  return `${cap} ${d.getDate()}. ${month} – ${phrase}`;
}

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

  const kindLabel =
    shownBrief?.kind === 'morning'
      ? 'Morgenbrief'
      : shownBrief?.kind === 'midday'
      ? 'Middagsbrief'
      : 'Aftenbrief';

  const sections = shownBrief?.sections ?? null;

  // A section renders only when it has content. Bulleted sections (calendar,
  // mails, followups) show a dot per item; prose sections (focus, weather)
  // render each string as its own line.
  function Section({
    icon: Icon,
    title,
    items,
    bulleted,
  }: {
    icon: LucideIcon;
    title: string;
    items: string[];
    bulleted: boolean;
  }) {
    if (items.length === 0) return null;
    return (
      <View style={{ marginTop: spacing.xl }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            marginBottom: spacing.md,
          }}
        >
          <Icon size={20} color={surface.successText} strokeWidth={2} />
          <Text
            style={{
              fontFamily: fonts.display,
              fontSize: 18,
              fontWeight: '600',
              letterSpacing: -0.3,
              color: t.ink,
            }}
          >
            {title}
          </Text>
        </View>
        {items.map((line, i) =>
          bulleted ? (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                gap: spacing.sm,
                paddingLeft: spacing.xs,
                marginBottom: 6,
              }}
            >
              <Text style={{ ...type.body, color: t.ink4 }}>•</Text>
              <Text style={{ ...type.body, color: t.ink2, flex: 1 }}>{line}</Text>
            </View>
          ) : (
            <Text key={i} style={{ ...type.body, color: t.ink2, marginBottom: 4 }}>
              {line}
            </Text>
          ),
        )}
      </View>
    );
  }

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
              <Text style={{ ...type.eyebrow, color: t.ink3 }}>{kindLabel}</Text>
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
            <GlassFrostedCard overlay={surface.bone} style={{ padding: spacing.lg }}>
              <Text
                style={{
                  fontFamily: fonts.display,
                  fontSize: 28,
                  lineHeight: 34,
                  letterSpacing: -0.5,
                  color: t.ink,
                }}
              >
                {modalTitle(shownBrief)}
              </Text>
              <View
                style={{
                  marginTop: spacing.md,
                  height: 1,
                  backgroundColor: t.line,
                }}
              />

              {sections ? (
                <>
                  <Section
                    icon={CalendarIcon}
                    title="Din kalender"
                    items={sections.calendar}
                    bulleted
                  />
                  <Section
                    icon={Mail}
                    title="Mails der kræver opmærksomhed"
                    items={sections.mails}
                    bulleted
                  />
                  <Section
                    icon={CheckCircle2}
                    title="Dine opfølgninger"
                    items={sections.followups}
                    bulleted
                  />
                  <Section
                    icon={Lightbulb}
                    title="Forslag til fokus i dag"
                    items={sections.focus}
                    bulleted={false}
                  />
                  <Section
                    icon={Cloud}
                    title="Vejr"
                    items={sections.weather}
                    bulleted={false}
                  />
                </>
              ) : (
                // Legacy briefs (no structured sections): prose body fallback.
                <View style={{ marginTop: spacing.md }}>
                  {shownBrief.body.map((line, i) => (
                    <Text
                      key={i}
                      style={{ ...type.body, color: t.ink2, marginBottom: spacing.md }}
                    >
                      {line}
                    </Text>
                  ))}
                </View>
              )}
            </GlassFrostedCard>
          )}
        </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
