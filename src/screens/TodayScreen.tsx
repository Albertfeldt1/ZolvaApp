import { Bell, Bookmark, ChevronRight } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CountUp } from '../components/CountUp';
import { DayRibbon, RibbonEvent } from '../components/DayRibbon';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { Stone } from '../components/Stone';
import { formatToday, greeting } from '../lib/date';
import {
  useHasProvider,
  useInboxWaiting,
  useNotes,
  useObservations,
  useReminders,
  useUnreadNotificationCount,
  useUpcoming,
  useUser,
} from '../lib/hooks';
import type { Observation, Reminder, UpcomingEvent } from '../lib/types';
import { colors, fonts } from '../theme';

const toneColor = (t: UpcomingEvent['tone']) =>
  t === 'sage' ? colors.sage : t === 'clay' ? colors.clay : t === 'warning' ? colors.warning : colors.stone;

type Props = {
  onOpenChat: () => void;
  onGoToSettings: () => void;
  onGoToMemory: () => void;
  onOpenNotifications: () => void;
  onOverDarkChange?: (over: boolean) => void;
};

const PILL_CLEARANCE = 76;

export function TodayScreen({
  onOpenChat,
  onGoToSettings,
  onGoToMemory,
  onOpenNotifications,
  onOverDarkChange,
}: Props) {
  const today = useMemo(() => new Date(), []);
  const dateInfo = useMemo(() => formatToday(today), [today]);
  const hello = useMemo(() => greeting(today), [today]);
  const { bottom: chromeBottom } = useChromeInsets();

  const { data: user } = useUser();
  const { data: observations } = useObservations();
  const { data: upcoming, error: upcomingError } = useUpcoming();
  const { data: waiting } = useInboxWaiting();
  const { data: reminders } = useReminders();
  const { data: notes } = useNotes();
  const unreadNotifications = useUnreadNotificationCount();
  const hasProvider = useHasProvider();

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const visibleObservations = useMemo(
    () => observations.filter((o) => !dismissedIds.has(o.id)),
    [observations, dismissedIds],
  );
  const dismissObservation = (id: string) =>
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  const pendingReminders = useMemo(
    () =>
      reminders
        .filter((r) => r.status === 'pending')
        .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)),
    [reminders],
  );
  const showHuskPreview = pendingReminders.length > 0 || notes.length > 0;

  const ribbonEvents: RibbonEvent[] = useMemo(() => {
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);
    const toHour = (d: Date) => d.getHours() + d.getMinutes() / 60;
    const kindFor = (title: string): RibbonEvent['kind'] => {
      const t = title.toLowerCase();
      if (t.includes('frokost') || t.includes('lunch')) return 'lunch';
      if (t.includes('fokus') || t.includes('focus') || t.includes('deep work')) return 'focus';
      return 'meeting';
    };
    return upcoming
      .filter((e) => !e.allDay && e.start < endOfDay && e.end > startOfDay)
      .map((e) => ({
        startHour: toHour(e.start),
        endHour: toHour(e.end),
        kind: kindFor(e.title),
        label: e.title,
      }));
  }, [upcoming, today]);

  const scrollYRef = useRef(0);
  const viewportHRef = useRef(0);
  const darkYRef = useRef<number | null>(null);
  const lastOverRef = useRef<boolean | null>(null);

  const checkOverDark = () => {
    if (!onOverDarkChange || darkYRef.current === null || viewportHRef.current === 0) return;
    const darkTop = darkYRef.current - scrollYRef.current;
    const pillTop = viewportHRef.current - PILL_CLEARANCE;
    const over = darkTop < pillTop;
    if (over !== lastOverRef.current) {
      lastOverRef.current = over;
      onOverDarkChange(over);
    }
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
    checkOverDark();
  };

  useEffect(() => {
    return () => {
      if (onOverDarkChange && lastOverRef.current) onOverDarkChange(false);
    };
  }, [onOverDarkChange]);

  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="never"
      onScroll={onScroll}
      scrollEventThrottle={16}
      onLayout={(e) => {
        viewportHRef.current = e.nativeEvent.layout.height;
        checkOverDark();
      }}
    >
      <View style={styles.hero}>
        <View style={styles.heroTopRow}>
          <Text style={styles.eyebrow}>{dateInfo.eyebrow}</Text>
          <Pressable
            onPress={onOpenNotifications}
            style={({ pressed }) => [styles.roundIcon, pressed && { opacity: 0.6 }]}
            hitSlop={8}
          >
            <Bell size={16} color={colors.ink} strokeWidth={1.75} />
            {unreadNotifications > 0 && <View style={styles.bellBadge} />}
          </Pressable>
        </View>
        <Text style={styles.heroH1}>
          {user ? `${hello},\n${user.name}.` : `${hello}.`}
        </Text>

        <View style={styles.statsRow}>
          <View>
            <CountUp to={upcoming.length} style={styles.statBig} />
            <Text style={styles.statLabel}>Møder</Text>
          </View>
          <View style={styles.statDivider} />
          <View>
            <CountUp to={waiting.length} style={styles.statMid} />
            <Text style={styles.statLabel}>Mails venter</Text>
          </View>
        </View>

        <DayRibbon events={ribbonEvents} now={today} />
      </View>

      {showHuskPreview && (
        <Pressable onPress={onGoToMemory} style={styles.huskCard}>
          <View style={styles.huskHead}>
            <View style={styles.huskIconWrap}>
              <Bookmark size={14} color={colors.sageDeep} strokeWidth={2} />
            </View>
            <Text style={styles.huskKicker}>Husk</Text>
            <Text style={styles.huskMeta}>
              {pendingReminders.length > 0 && `${pendingReminders.length} påmindelser`}
              {pendingReminders.length > 0 && notes.length > 0 && ' · '}
              {notes.length > 0 && `${notes.length} noter`}
            </Text>
            <ChevronRight size={16} color={colors.fg4} strokeWidth={1.75} />
          </View>
          {pendingReminders.slice(0, 2).map((r) => (
            <HuskReminderLine key={r.id} reminder={r} now={today} />
          ))}
        </Pressable>
      )}

      <View style={styles.næste}>
        <View style={styles.sectionHeadRow}>
          <Text style={styles.sectionTitle}>Næste</Text>
          <Text style={styles.sectionMeta}>
            {upcoming.length > 0 ? `${upcoming.length} i dag` : '-'}
          </Text>
        </View>
        <View style={styles.inkRule} />
        {upcoming.length === 0 ? (
          hasProvider ? (
            <EmptyState
              mood="calm"
              title={upcomingError ? 'Kunne ikke hente kalender' : 'Ingen aftaler i dag'}
              body={
                upcomingError
                  ? 'Din forbindelse er måske udløbet. Log ud og forbind igen.'
                  : 'Du har en rolig dag foran dig.'
              }
              ctaLabel={upcomingError ? 'Gå til indstillinger' : undefined}
              onCta={upcomingError ? onGoToSettings : undefined}
            />
          ) : (
            <EmptyState
              mood="calm"
              title="Ingen aftaler i dag"
              body="Forbind din kalender, så samler jeg dagens møder her."
              ctaLabel="Forbind kalender"
              onCta={onGoToSettings}
            />
          )
        ) : (
          upcoming.map((e, i) => (
            <View key={e.id} style={[styles.row, i > 0 && styles.rowBorder]}>
              <View style={styles.timeCol}>
                <Text style={styles.timeTop}>{e.time}</Text>
                <Text style={styles.timeMeta}>{e.meta}</Text>
              </View>
              <View style={[styles.rowBody, { borderLeftColor: toneColor(e.tone) }]}>
                <Text style={styles.rowTitle}>{e.title}</Text>
                <Text style={styles.rowSub}>{e.sub}</Text>
              </View>
              <ChevronRight size={18} color={colors.fg4} strokeWidth={1.75} />
            </View>
          ))
        )}
      </View>

      <View
        style={[styles.dark, { paddingBottom: chromeBottom }]}
        onLayout={(e) => {
          darkYRef.current = e.nativeEvent.layout.y;
          checkOverDark();
        }}
      >
        <Text style={styles.darkTitle}>Hvad jeg har bemærket</Text>
        {visibleObservations.length === 0 ? (
          hasProvider ? (
            <EmptyState
              dark
              mood="thinking"
              title="Intet at fortælle endnu"
              body="Jeg lærer stadig dine mønstre at kende. De første observationer dukker op efter et par dage."
            />
          ) : (
            <EmptyState
              dark
              mood="thinking"
              title="Intet at fortælle endnu"
              body="Når jeg har adgang til din indbakke og kalender, samler jeg observationer her."
              ctaLabel="Forbind konti"
              onCta={onGoToSettings}
            />
          )
        ) : (
          <View style={{ gap: 14 }}>
            {visibleObservations.map((n, i) => (
              <NoticedRow
                key={n.id}
                item={n}
                index={i}
                onOpenChat={onOpenChat}
                onDismiss={() => dismissObservation(n.id)}
              />
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function HuskReminderLine({ reminder, now }: { reminder: Reminder; now: Date }) {
  const dueAt = reminder.dueAt;
  let timeLabel: string;
  if (!dueAt) {
    timeLabel = 'Ingen tid';
  } else {
    const time = `${dueAt.getHours().toString().padStart(2, '0')}.${dueAt.getMinutes().toString().padStart(2, '0')}`;
    const sameDay =
      dueAt.getFullYear() === now.getFullYear() &&
      dueAt.getMonth() === now.getMonth() &&
      dueAt.getDate() === now.getDate();
    timeLabel = sameDay ? time : `${dueAt.getDate()}.${dueAt.getMonth() + 1}`;
  }
  return (
    <View style={styles.huskLine}>
      <Text style={styles.huskTime}>{timeLabel}</Text>
      <Text style={styles.huskText} numberOfLines={1}>{reminder.text}</Text>
    </View>
  );
}

function NoticedRow({
  item,
  index,
  onOpenChat,
  onDismiss,
}: {
  item: Observation;
  index: number;
  onOpenChat: () => void;
  onDismiss: () => void;
}) {
  const fade = React.useRef(new Animated.Value(0)).current;
  const slide = React.useRef(new Animated.Value(8)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 600, delay: index * 120, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 600, delay: index * 120, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true }),
    ]).start();
  }, [fade, slide, index]);

  const animateOut = (after: () => void) => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(slide, { toValue: -8, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start(after);
  };

  return (
    <Animated.View style={[styles.noticedRow, { opacity: fade, transform: [{ translateY: slide }] }]}>
      <Stone mood={item.mood} size={36} />
      <View style={{ flex: 1 }}>
        <Text style={styles.noticedText}>{item.text}</Text>
        <View style={styles.noticedActions}>
          <Pressable onPress={onOpenChat}>
            <Text style={styles.noticedCta}>{item.cta} →</Text>
          </Pressable>
          <Pressable onPress={() => animateOut(onDismiss)}>
            <Text style={styles.noticedDismiss}>Afvis</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1, backgroundColor: colors.paper },

  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56,
    paddingBottom: 24,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  heroTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  roundIcon: {
    width: 34, height: 34, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  bellBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.clay,
    borderWidth: 1.5,
    borderColor: colors.paper,
  },
  heroH1: {
    marginTop: 10,
    fontFamily: fonts.displayItalic,
    fontSize: 40,
    lineHeight: 44,
    letterSpacing: -1.4,
    color: colors.ink,
  },

  statsRow: {
    marginTop: 28,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 24,
  },
  statBig: {
    fontFamily: fonts.display,
    fontSize: 80,
    letterSpacing: -4,
    lineHeight: 84,
    color: colors.ink,
  },
  statMid: {
    fontFamily: fonts.display,
    fontSize: 48,
    letterSpacing: -1.44,
    lineHeight: 52,
    color: colors.ink,
  },
  statLabel: {
    marginTop: 6,
    fontFamily: fonts.uiSemi,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.fg3,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: colors.line,
    marginBottom: 8,
  },

  huskCard: {
    marginTop: 28,
    marginHorizontal: 20,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: colors.mist,
    gap: 8,
  },
  huskHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  huskIconWrap: {
    width: 24, height: 24, borderRadius: 999,
    backgroundColor: colors.sageSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  huskKicker: {
    fontFamily: fonts.uiSemi, fontSize: 12,
    letterSpacing: 0.6, textTransform: 'uppercase', color: colors.ink,
  },
  huskMeta: { flex: 1, fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },
  huskLine: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  huskTime: {
    fontFamily: fonts.mono, fontSize: 11, color: colors.sageDeep,
    minWidth: 42,
  },
  huskText: { flex: 1, fontFamily: fonts.ui, fontSize: 13, color: colors.ink },

  næste: { paddingHorizontal: 20, paddingTop: 40 },
  sectionHeadRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4,
  },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 24,
    letterSpacing: -0.48,
    color: colors.ink,
  },
  sectionMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.fg3,
  },
  inkRule: { height: 1, backgroundColor: colors.ink, marginBottom: 2 },
  emptyText: {
    paddingVertical: 20,
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 13,
    color: colors.fg3,
  },
  row: { flexDirection: 'row', gap: 14, alignItems: 'center', paddingVertical: 18 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  timeCol: { width: 72 },
  timeTop: {
    fontFamily: fonts.display,
    fontSize: 20,
    letterSpacing: -0.4,
    color: colors.ink,
    lineHeight: 24,
  },
  timeMeta: {
    marginTop: 4,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.fg3,
  },
  rowBody: { flex: 1, borderLeftWidth: 2, paddingLeft: 12 },
  rowTitle: { fontFamily: fonts.uiSemi, fontSize: 14.5, color: colors.ink },
  rowSub: { marginTop: 2, fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg3 },

  dark: {
    marginTop: 40,
    backgroundColor: colors.ink,
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  darkTitle: {
    marginBottom: 14,
    fontFamily: fonts.displayItalic,
    fontSize: 24,
    letterSpacing: -0.36,
    color: colors.paper,
  },
  darkEmpty: {
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 14,
    lineHeight: 21,
    color: colors.paperOn55,
  },
  noticedRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  noticedText: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 21, color: colors.paperOn95 },
  noticedActions: { marginTop: 8, flexDirection: 'row', gap: 16 },
  noticedCta: { fontFamily: fonts.uiSemi, fontSize: 12.5, color: colors.sageDim },
  noticedDismiss: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.paperOn50 },
});
