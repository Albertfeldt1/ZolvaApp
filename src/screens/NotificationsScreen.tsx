import { Bell, BookmarkPlus, Calendar, ChevronLeft, Mail, Sun } from 'lucide-react-native';
import React, { useMemo } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { EmptyState } from '../components/EmptyState';
import { useNotificationFeed } from '../lib/hooks';
import type { FeedEntry, NotificationPayload } from '../lib/types';
import { colors, fonts } from '../theme';

type Props = {
  onClose: () => void;
  onNavigate: (payload: NotificationPayload) => void;
};

export function NotificationsScreen({ onClose, onNavigate }: Props) {
  const { data: entries, markRead, markAll } = useNotificationFeed();
  const now = useMemo(() => new Date(), []);
  const groups = useMemo(() => groupByDay(entries, now), [entries, now]);
  const hasUnread = entries.some((e) => e.readAt == null);

  const handleRowPress = (entry: FeedEntry) => {
    markRead(entry.id);
    onNavigate(entry.payload);
  };

  return (
    <View style={styles.flex}>
      <View style={styles.topBar}>
        <Pressable onPress={onClose} style={styles.roundBtn} hitSlop={8}>
          <ChevronLeft size={18} color={colors.ink} strokeWidth={1.75} />
        </Pressable>
        <Text style={styles.topTitle}>Notifikationer</Text>
        <Pressable
          onPress={markAll}
          disabled={!hasUnread}
          hitSlop={8}
          style={({ pressed }) => [
            styles.markAll,
            !hasUnread && styles.markAllDisabled,
            pressed && hasUnread && styles.markAllPressed,
          ]}
        >
          <Text style={[styles.markAllText, !hasUnread && styles.markAllTextDisabled]}>
            Markér alle
          </Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {entries.length === 0 ? (
          <View style={styles.emptyWrap}>
            <EmptyState
              mood="calm"
              title="Ingen notifikationer endnu"
              body="Når jeg planlægger noget for dig, dukker det op her."
            />
          </View>
        ) : (
          groups.map((group) => (
            <View key={group.key} style={styles.group}>
              <Text style={styles.groupHeader}>{group.label}</Text>
              <View style={styles.inkRule} />
              {group.entries.map((entry) => (
                <Row key={entry.id} entry={entry} onPress={() => handleRowPress(entry)} />
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function Row({ entry, onPress }: { entry: FeedEntry; onPress: () => void }) {
  const Icon = iconFor(entry.type);
  const unread = entry.readAt == null;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.dotCol}>{unread && <View style={styles.unreadDot} />}</View>
      <View style={styles.iconWrap}>
        <Icon size={16} color={colors.sageDeep} strokeWidth={1.75} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, !unread && styles.titleRead]} numberOfLines={1}>
          {entry.title}
        </Text>
        {entry.body && (
          <Text style={styles.subtitle} numberOfLines={2}>
            {entry.body}
          </Text>
        )}
      </View>
      <Text style={styles.time}>{shortTime(entry.firesAt)}</Text>
    </Pressable>
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

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.paper },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: Platform.OS === 'ios' ? 58 : 40,
    paddingBottom: 10,
    paddingHorizontal: 16,
    backgroundColor: colors.paper,
  },
  roundBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: colors.mist,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    flex: 1,
    fontFamily: fonts.uiSemi,
    fontSize: 15,
    color: colors.ink,
  },
  markAll: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.mist,
  },
  markAllDisabled: { opacity: 0.4 },
  markAllPressed: { opacity: 0.7 },
  markAllText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    color: colors.ink,
  },
  markAllTextDisabled: { color: colors.fg3 },

  scrollContent: { paddingBottom: 40 },

  emptyWrap: { paddingTop: 48 },

  group: { paddingHorizontal: 22, paddingTop: 20 },
  groupHeader: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.fg3,
  },
  inkRule: {
    marginTop: 8,
    marginBottom: 4,
    height: 1,
    backgroundColor: colors.ink,
    opacity: 0.45,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    gap: 12,
  },
  rowPressed: { opacity: 0.6 },
  dotCol: {
    width: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.clay,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: colors.sageSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, gap: 2 },
  title: {
    fontFamily: fonts.uiSemi,
    fontSize: 14,
    color: colors.ink,
  },
  titleRead: { color: colors.fg2, fontFamily: fonts.ui },
  subtitle: {
    fontFamily: fonts.ui,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.fg3,
  },
  time: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.fg3,
  },
});
