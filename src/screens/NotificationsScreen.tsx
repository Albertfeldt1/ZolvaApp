import {
  Bell,
  BookmarkPlus,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  Hourglass,
  Mail,
  Sun,
  Sunrise,
} from 'lucide-react-native';
import React, { useMemo } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';
import { useNotificationFeed } from '../lib/hooks';
import type { FeedEntry, NotificationPayload } from '../lib/types';

type Props = {
  onClose: () => void;
  onNavigate: (payload: NotificationPayload) => void;
};

export function NotificationsScreen({ onClose, onNavigate }: Props) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const { data: entries, markRead, markAll } = useNotificationFeed();
  const now = useMemo(() => new Date(), []);
  const groups = useMemo(() => groupByDay(entries, now), [entries, now]);
  const hasUnread = entries.some((e) => e.readAt == null);

  const handleRowPress = (entry: FeedEntry) => {
    markRead(entry.id);
    onNavigate(entry.payload);
  };

  return (
    <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
      <GlassHaloLayer />

      {/* Top bar */}
      <View
        style={{
          paddingTop: Platform.OS === 'ios' ? 58 : 40,
          paddingBottom: spacing.md,
          paddingHorizontal: spacing.screenPad,
          position: 'relative',
          zIndex: 1,
        }}
      >
        <GlassFrostedCard
          radius={radius.card}
          style={{
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.cardPad,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
          }}
        >
          {/* Back button */}
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Tilbage"
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              borderRadius: radius.pill,
              backgroundColor: surface.iconButton,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <ChevronLeft size={18} color={t.ink2} strokeWidth={1.75} />
          </Pressable>

          {/* Title */}
          <View style={{ flex: 1 }}>
            <Text style={{ ...type.eyebrow, color: t.ink3 }}>NOTIFIKATIONER</Text>
          </View>

          {/* Mark all read */}
          <Pressable
            onPress={markAll}
            disabled={!hasUnread}
            hitSlop={8}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm - 1,
              borderRadius: radius.pill,
              backgroundColor: hasUnread ? surface.glassWeak : 'transparent',
              opacity: !hasUnread ? 0.35 : pressed ? 0.6 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: fonts.uiBold,
                fontSize: 12,
                color: hasUnread ? t.ink : t.ink3,
              }}
            >
              Markér alle
            </Text>
          </Pressable>
        </GlassFrostedCard>
      </View>

      {/* List */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        {entries.length === 0 ? (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.lg }}>
            <GlassFrostedCard overlay={surface.bone} style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.lg }}>
              <Stone size={56} jumpOnTap={false} />
              <Text
                style={{
                  fontFamily: fonts.display,
                  fontSize: 20,
                  letterSpacing: -0.4,
                  color: t.ink,
                  textAlign: 'center',
                }}
              >
                Ingen notifikationer endnu
              </Text>
              <Text style={{ ...type.body, color: t.ink3, textAlign: 'center' }}>
                Når jeg planlægger noget for dig, dukker det op her.
              </Text>
            </GlassFrostedCard>
          </View>
        ) : (
          groups.map((group) => (
            <View key={group.key} style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
              {/* Day label eyebrow */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  paddingHorizontal: spacing.xs,
                  paddingBottom: spacing.sm,
                }}
              >
                <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600' }}>
                  {group.label}
                </Text>
                <Text style={{ ...type.eyebrow, color: t.ink3 }}>{group.entries.length}</Text>
              </View>

              {/* Group card */}
              <GlassFrostedCard style={{ overflow: 'hidden' }}>
                {group.entries.map((entry, idx) => (
                  <NotifRow
                    key={entry.id}
                    entry={entry}
                    onPress={() => handleRowPress(entry)}
                    showDivider={idx < group.entries.length - 1}
                  />
                ))}
              </GlassFrostedCard>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

type RowProps = {
  entry: FeedEntry;
  onPress: () => void;
  showDivider: boolean;
};

function NotifRow({ entry, onPress, showDivider }: RowProps) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const LucideIcon = iconFor(entry.type);
  const unread = entry.readAt == null;

  return (
    <>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.cardPad,
          gap: spacing.md,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {/* Unread dot column */}
        <View style={{ width: 8, alignItems: 'center', justifyContent: 'center' }}>
          {unread && (
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: t.today,
              }}
            />
          )}
        </View>

        {/* Icon badge */}
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: radius.pill,
            backgroundColor: surface.glassWeak,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <LucideIcon size={16} color={t.ink2} strokeWidth={1.75} />
        </View>

        {/* Text */}
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            style={{
              fontFamily: unread ? fonts.uiBold : fonts.ui,
              fontSize: 14,
              color: unread ? t.ink : t.ink2,
            }}
            numberOfLines={1}
          >
            {entry.title}
          </Text>
          {entry.body && (
            <Text
              style={{ ...type.bodySm, color: t.ink3, lineHeight: 18 }}
              numberOfLines={2}
            >
              {entry.body}
            </Text>
          )}
        </View>

        {/* Time */}
        <Text style={{ ...type.caption, color: t.ink3 }}>{shortTime(entry.firesAt)}</Text>
      </Pressable>

      {showDivider && (
        <View
          style={{
            height: 1,
            marginLeft: spacing.cardPad + 8 + spacing.md + 34 + spacing.md,
            backgroundColor: t.line,
          }}
        />
      )}
    </>
  );
}

function iconFor(type: FeedEntry['type']) {
  switch (type) {
    case 'reminder':
      return Bell;
    case 'digest':
      return Sun;
    case 'calendarPreAlert':
      return Calendar;
    case 'reminderAdded':
      return BookmarkPlus;
    case 'newMail':
      return Mail;
    case 'brief':
      return Sunrise;
    case 'factDecay':
      return Hourglass;
    case 'microsoftConsentGranted':
      return CheckCircle2;
  }
}

type Group = { key: string; label: string; entries: FeedEntry[] };

function groupByDay(entries: FeedEntry[], now: Date): Group[] {
  const groups = new Map<string, FeedEntry[]>();
  for (const e of entries) {
    const k = dayKey(e.firesAt);
    const list = groups.get(k) ?? [];
    list.push(e);
    groups.set(k, list);
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, list]) => ({
      key,
      label: dayLabel(list[0].firesAt, now),
      entries: list,
    }));
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS_DA = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function dayLabel(d: Date, now: Date): string {
  if (isSameDay(d, now)) return 'I dag';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(d, yesterday)) return 'I går';
  const sameYear = d.getFullYear() === now.getFullYear();
  const base = `${d.getDate()}. ${MONTHS_DA[d.getMonth()]}`;
  return sameYear ? base : `${base} ${d.getFullYear()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function shortTime(d: Date): string {
  return `${pad(d.getHours())}.${pad(d.getMinutes())}`;
}
