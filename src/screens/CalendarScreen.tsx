import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { Skeleton } from '../components/Skeleton';
import { formatToday, weekStrip, type WeekStripDay } from '../lib/date';
import { useDaySchedule, useHasProvider } from '../lib/hooks';
import type { CalendarSlot } from '../lib/types';
import { colors, fonts } from '../theme';
import { translateProviderError } from '../utils/danish';

type EventTone = NonNullable<CalendarSlot['event']>['tone'];
const toneColor = (t: EventTone) =>
  t === 'sage' ? colors.sage : t === 'clay' ? colors.clay : colors.stone;

function copenhagenNowMinutes(): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Copenhagen',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const rawH = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour: rawH === 24 ? 0 : rawH, minute: m };
}

function copenhagenDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
}

type Props = { onGoToSettings: () => void };

// Horizontal paging window: ~1 year each way is plenty for finger scrolling.
const WEEKS_BEFORE = 26;
const WEEKS_AFTER = 26;
const WEEKS_TOTAL = WEEKS_BEFORE + 1 + WEEKS_AFTER;

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function CalendarScreen({ onGoToSettings }: Props) {
  const [today, setToday] = useState<Date>(() => new Date());
  const [selectedDate, setSelectedDate] = useState<Date>(today);
  const [pageIndex, setPageIndex] = useState<number>(WEEKS_BEFORE);
  const [pageWidth, setPageWidth] = useState<number>(0);

  const weekScrollRef = useRef<ScrollView>(null);
  const didInitScroll = useRef(false);

  useEffect(() => {
    if (pageWidth > 0 && !didInitScroll.current) {
      weekScrollRef.current?.scrollTo({ x: WEEKS_BEFORE * pageWidth, animated: false });
      didInitScroll.current = true;
    }
  }, [pageWidth]);

  const weeks = useMemo<WeekStripDay[][]>(
    () =>
      Array.from({ length: WEEKS_TOTAL }, (_, i) => {
        const anchor = addDays(today, (i - WEEKS_BEFORE) * 7);
        return weekStrip(anchor, { today, selected: selectedDate });
      }),
    [today, selectedDate],
  );

  const visibleAnchor = useMemo(
    () => addDays(today, (pageIndex - WEEKS_BEFORE) * 7),
    [today, pageIndex],
  );
  const visibleDate = useMemo(() => formatToday(visibleAnchor), [visibleAnchor]);
  const selectedInfo = useMemo(() => formatToday(selectedDate), [selectedDate]);
  const isSelectedToday = sameDay(selectedDate, today);

  const { data: slots, loading: scheduleLoading, error: scheduleError } = useDaySchedule(selectedDate);
  const hasEvents = slots.some((s) => s.event);
  const hasProvider = useHasProvider();
  const { bottom: chromeBottom } = useChromeInsets();

  const [now, setNow] = useState(copenhagenNowMinutes);
  useEffect(() => {
    const tick = () => {
      const fresh = new Date();
      if (copenhagenDateKey(fresh) !== copenhagenDateKey(today)) {
        setToday(fresh);
      }
      setNow(copenhagenNowMinutes());
    };
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [today]);

  const [rowLayouts, setRowLayouts] = useState<Record<string, { y: number; height: number }>>({});
  useEffect(() => {
    setRowLayouts({});
  }, [slots]);
  const onRowLayout = (hour: string, y: number, height: number) => {
    setRowLayouts((prev) => {
      const cur = prev[hour];
      if (cur && cur.y === y && cur.height === height) return prev;
      return { ...prev, [hour]: { y, height } };
    });
  };

  const nowHourKey = String(now.hour).padStart(2, '0');
  const nowRow = rowLayouts[nowHourKey];
  const showNowLine = isSelectedToday && hasEvents && Boolean(nowRow);
  const nowTop = nowRow ? nowRow.y + (now.minute / 60) * nowRow.height : 0;

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!pageWidth) return;
    const idx = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    if (idx !== pageIndex) {
      Haptics.selectionAsync();
      setPageIndex(idx);
    }
  };

  const selectDay = (d: Date) => {
    if (sameDay(d, selectedDate)) return;
    Haptics.selectionAsync();
    setSelectedDate(d);
  };

  const jumpToToday = () => {
    Haptics.selectionAsync();
    setSelectedDate(today);
    if (pageWidth > 0) {
      weekScrollRef.current?.scrollTo({ x: WEEKS_BEFORE * pageWidth, animated: true });
    }
    setPageIndex(WEEKS_BEFORE);
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom }]}
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="never"
    >
      <View style={styles.hero}>
        <View style={styles.heroTopRow}>
          <Text style={styles.eyebrow}>{visibleDate.weekHeadline}</Text>
          {(pageIndex !== WEEKS_BEFORE || !isSelectedToday) && (
            <Pressable onPress={jumpToToday} hitSlop={8}>
              <Text style={styles.todayLink}>I dag</Text>
            </Pressable>
          )}
        </View>
        <Text style={styles.heroH1}>{selectedInfo.dayHeadline}</Text>

        <View
          style={styles.stripWrap}
          onLayout={(e) => setPageWidth(e.nativeEvent.layout.width)}
        >
          {pageWidth > 0 && (
            <ScrollView
              ref={weekScrollRef}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              decelerationRate="fast"
              onMomentumScrollEnd={onMomentumEnd}
              scrollEventThrottle={16}
            >
              {weeks.map((week, wi) => (
                <View key={wi} style={[styles.weekPage, { width: pageWidth }]}>
                  {week.map((d, di) => (
                    <Pressable
                      key={di}
                      onPress={() => selectDay(d.date)}
                      style={({ pressed }) => [
                        styles.dayCell,
                        d.isSelected && styles.dayCellSelected,
                        d.isToday && !d.isSelected && styles.dayCellToday,
                        pressed && !d.isSelected && styles.dayCellPressed,
                      ]}
                      hitSlop={4}
                    >
                      <Text
                        style={[
                          styles.dayLetter,
                          d.isSelected && styles.dayLetterSelected,
                          d.isToday && !d.isSelected && styles.dayLetterToday,
                        ]}
                      >
                        {d.letter}
                      </Text>
                      <Text
                        style={[
                          styles.dayNum,
                          d.isSelected && styles.dayNumSelected,
                          d.isToday && !d.isSelected && styles.dayNumToday,
                        ]}
                      >
                        {d.num}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>

      <View style={styles.list}>
        <Text style={styles.sectionTitle}>
          {isSelectedToday ? 'I dag' : selectedInfo.dayHeadline}
        </Text>
        <View style={styles.inkRule} />
        {!hasEvents ? (
          scheduleLoading && hasProvider && !scheduleError ? (
            <View>
              {Array.from({ length: 4 }).map((_, i) => (
                <View key={i} style={[styles.row, i > 0 && styles.rowBorder]}>
                  <Skeleton width={36} height={16} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Skeleton width="70%" height={14} />
                    <Skeleton width="45%" height={12} style={{ marginTop: 6 }} />
                  </View>
                </View>
              ))}
            </View>
          ) : hasProvider ? (
            (() => {
              const err = scheduleError ? translateProviderError(scheduleError) : null;
              const isAuth = err?.kind === 'auth';
              const emptyBody = isSelectedToday
                ? 'Du har en rolig dag foran dig.'
                : 'Ingen begivenheder på denne dag.';
              return (
                <EmptyState
                  mood="calm"
                  title={
                    err
                      ? err.kind === 'network'
                        ? 'Ingen forbindelse'
                        : 'Kunne ikke hente kalender'
                      : 'Ingen aftaler'
                  }
                  body={err ? err.message : emptyBody}
                  ctaLabel={isAuth ? 'Gå til indstillinger' : undefined}
                  onCta={isAuth ? onGoToSettings : undefined}
                />
              );
            })()
          ) : (
            <EmptyState
              mood="calm"
              title="Ingen aftaler"
              body="Forbind Google eller Outlook Kalender for at se din dagsplan."
              ctaLabel="Forbind kalender"
              onCta={onGoToSettings}
            />
          )
        ) : (
          <View style={styles.grid}>
            {slots.map((row, i) => (
              <View
                key={i}
                style={[styles.row, i > 0 && styles.rowBorder]}
                onLayout={(e) =>
                  onRowLayout(row.hour, e.nativeEvent.layout.y, e.nativeEvent.layout.height)
                }
              >
                <Text style={[styles.hour, !row.event && styles.hourDim]}>{row.hour}</Text>
                <View style={{ flex: 1 }}>
                  {row.event ? (
                    <View style={[styles.event, { borderLeftColor: toneColor(row.event.tone) }]}>
                      <Text style={styles.eventTitle}>{row.event.title}</Text>
                      <Text style={styles.eventSub}>{row.event.sub}</Text>
                    </View>
                  ) : (
                    <Text style={styles.empty}>-</Text>
                  )}
                </View>
              </View>
            ))}
            {showNowLine && (
              <View style={[styles.nowWrap, { top: nowTop }]} pointerEvents="none">
                <View style={styles.nowDot} />
                <View style={styles.nowBar} />
              </View>
            )}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, backgroundColor: colors.paper },

  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56,
    paddingBottom: 20,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  heroTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.88,
    textTransform: 'uppercase', color: colors.sageDeep,
  },
  todayLink: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 10,
    fontFamily: fonts.displayItalic,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -1.08,
    color: colors.ink,
  },

  stripWrap: {
    marginTop: 16,
    overflow: 'hidden',
  },
  weekPage: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'space-between',
  },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 10,
  },
  dayCellSelected: { backgroundColor: colors.ink },
  dayCellToday: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.ink,
  },
  dayCellPressed: { opacity: 0.55 },
  dayLetter: {
    fontFamily: fonts.mono, fontSize: 10,
    letterSpacing: 0.5, color: colors.ink, opacity: 0.7,
  },
  dayLetterSelected: { color: colors.paper, opacity: 0.8 },
  dayLetterToday: { opacity: 1 },
  dayNum: {
    marginTop: 2, fontFamily: fonts.display, fontSize: 20, lineHeight: 24, color: colors.ink,
  },
  dayNumSelected: { color: colors.paper },
  dayNumToday: { color: colors.ink },

  list: { paddingHorizontal: 20, paddingTop: 32 },
  sectionTitle: { fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.44, color: colors.ink },
  inkRule: { height: 1, backgroundColor: colors.ink, marginTop: 4 },
  emptyText: {
    paddingVertical: 20,
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 13,
    color: colors.fg3,
  },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 12 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  hour: {
    width: 48, fontFamily: fonts.display, fontSize: 18, color: colors.ink, lineHeight: 22,
  },
  hourDim: { color: colors.fg4 },
  event: {
    borderLeftWidth: 3,
    paddingLeft: 12,
  },
  eventTitle: { fontFamily: fonts.uiSemi, fontSize: 14, color: colors.ink },
  eventSub: { marginTop: 2, fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg3 },
  empty: { fontFamily: 'Inter_500Medium_Italic', fontSize: 12, color: colors.fg4 },
  grid: { position: 'relative' },
  nowWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 10,
  },
  nowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.clayInk,
  },
  nowBar: {
    flex: 1,
    height: 1.5,
    backgroundColor: colors.clayInk,
  },
});
