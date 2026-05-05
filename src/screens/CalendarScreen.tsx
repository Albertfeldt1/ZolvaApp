import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { GlassView } from 'expo-glass-effect';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { CalendarPickerSheet } from '../components/CalendarPickerSheet';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { Skeleton } from '../components/Skeleton';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { TopBar } from '../design/primitives/TopBar';
import { useTheme } from '../design/useTheme';
import { weekStrip, type WeekStripDay } from '../lib/date';
import { useDaySchedule, useHasProvider } from '../lib/hooks';
import { liquidGlassReady } from '../lib/liquid-glass';
import type { CalendarSlot } from '../lib/types';
import { translateProviderError } from '../utils/danish';

// Same physics as LiquidTabBar / LiquidTabSwitcher so all springy pills feel
// like one system.
const DAY_PILL_SPRING = { damping: 22, stiffness: 260, mass: 1 };
// Belt geometry: explicit height so the active pill renders at the same height
// as the cells (using top:0/bottom:0 left the pill rendering taller than the
// row visually). The belt is a single capsule that holds all 7 days.
const BELT_HEIGHT = 56;
const BELT_INSET = 4;
// Inset the outline a few px from each cell edge so the bordered pill hugs
// the day text instead of touching the next cell. Manual rightward nudge
// compensates for mono-letter + display-digit not being perfectly centred
// in their typeface metrics.
const PILL_HUG = 6;
const PILL_X_NUDGE = 0;

type EventTone = NonNullable<CalendarSlot['event']>['tone'];

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

/** Build "MAJ 2026"-style eyebrow from a date. */
function monthYearEyebrow(d: Date): string {
  return new Intl.DateTimeFormat('da-DK', { month: 'long', year: 'numeric' })
    .format(d)
    .toUpperCase();
}

/** First line of display headline — e.g. "Tirsdag" capitalised. */
function weekdayHeadline(d: Date): string {
  const s = new Intl.DateTimeFormat('da-DK', { weekday: 'long' }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Short Danish month — strips trailing period from da-DK short format. */
function shortMonth(d: Date): string {
  return new Intl.DateTimeFormat('da-DK', { month: 'short' }).format(d).replace('.', '');
}

type Props = {
  onGoToSettings: () => void;
  onOpenNotifications: () => void;
};

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

export function CalendarScreen({ onGoToSettings, onOpenNotifications }: Props) {
  const { t, type, fonts, radius, spacing, surface, shadows } = useTheme();

  // toneColor needs access to t, so lives inside the component.
  const toneColor = (tone: EventTone): string =>
    tone === 'sage' ? t.cal : tone === 'clay' ? t.today : t.ink3;

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
  const isSelectedToday = sameDay(selectedDate, today);

  const { data: slots, loading: scheduleLoading, error: scheduleError } = useDaySchedule(selectedDate);
  const hasEvents = slots.some((s) => s.event);
  const hasProvider = useHasProvider();
  const { bottom: chromeBottom } = useChromeInsets();
  const [pickerOpen, setPickerOpen] = useState(false);

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
  // Reset when the user picks a different day; don't reset on every
  // `slots` reference change — useDaySchedule returns a fresh array each
  // render, which turned this into an infinite setState loop.
  useEffect(() => {
    setRowLayouts({});
  }, [selectedDate]);
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

  // Horizontal swipe on the body advances the selected day by one. If the new
  // day falls outside the currently visible week, page the strip to match.
  const advanceDay = (dir: 1 | -1) => {
    const next = addDays(selectedDate, dir);
    if (Platform.OS === 'ios') Haptics.selectionAsync().catch(() => {});
    setSelectedDate(next);
    const inVisible = weeks[pageIndex]?.some((d) => sameDay(d.date, next));
    if (!inVisible) {
      const targetIdx = weeks.findIndex((w) => w.some((d) => sameDay(d.date, next)));
      if (targetIdx >= 0 && pageWidth > 0) {
        weekScrollRef.current?.scrollTo({ x: targetIdx * pageWidth, animated: true });
        setPageIndex(targetIdx);
      }
    }
  };

  // Strip-level active-day pill. Lives once across the whole horizontal
  // ScrollView so it can spring from one week's day to another when the
  // user pages forward (or back) and THEN taps a day — instead of popping
  // in cold at the new position. X is global within the scroll content.
  const selectedPosition = useMemo(() => {
    for (let wi = 0; wi < weeks.length; wi++) {
      const di = weeks[wi].findIndex((d) => sameDay(d.date, selectedDate));
      if (di >= 0) return { weekIdx: wi, dayIdx: di };
    }
    return null;
  }, [weeks, selectedDate]);

  const stripPillX = useSharedValue(0);
  const stripPillSet = useRef(false);

  useEffect(() => {
    if (!selectedPosition || pageWidth === 0) return;
    const innerWidth = pageWidth - BELT_INSET * 2;
    const cellWidth = innerWidth / 7;
    const target =
      selectedPosition.weekIdx * pageWidth +
      BELT_INSET +
      selectedPosition.dayIdx * cellWidth +
      PILL_HUG +
      PILL_X_NUDGE;
    if (!stripPillSet.current) {
      // First measurement: snap so the pill appears under the already-
      // selected day on initial mount instead of springing from x=0.
      stripPillX.value = target;
      stripPillSet.current = true;
    } else {
      stripPillX.value = withSpring(target, DAY_PILL_SPRING);
    }
  }, [selectedPosition, pageWidth, stripPillX]);

  const stripPillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: stripPillX.value }],
  }));

  const stripPillWidth = useMemo(() => {
    if (pageWidth === 0) return 0;
    const cellWidth = (pageWidth - BELT_INSET * 2) / 7;
    return Math.max(0, cellWidth - PILL_HUG * 2);
  }, [pageWidth]);

  const dayPanResponder = useMemo(
    () =>
      PanResponder.create({
        // Don't claim on touch start — let taps and vertical scroll work.
        onStartShouldSetPanResponder: () => false,
        // Only claim when horizontal motion clearly dominates.
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderRelease: (_, g) => {
          if (Math.abs(g.dx) < 50) return;
          advanceDay(g.dx < 0 ? 1 : -1);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedDate, pageIndex, pageWidth, weeks],
  );

  const jumpToToday = () => {
    Haptics.selectionAsync();
    setSelectedDate(today);
    if (pageWidth > 0) {
      weekScrollRef.current?.scrollTo({ x: WEEKS_BEFORE * pageWidth, animated: true });
    }
    setPageIndex(WEEKS_BEFORE);
  };

  // Derived display strings for the headline area.
  const eyebrow = monthYearEyebrow(visibleAnchor);
  const weekdayLine = weekdayHeadline(selectedDate);
  const dateLine = `${selectedDate.getDate()}. ${shortMonth(selectedDate)}.`;
  const sectionTitle = isSelectedToday ? 'I dag' : `${weekdayLine}, ${dateLine}`;

  return (
    <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
      <GlassHaloLayer />
      <View style={{ position: 'relative', flex: 1 }}>
        <TopBar
          eyebrow={eyebrow}
          onBell={onOpenNotifications}
          onGear={onGoToSettings}
        />

        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingBottom: chromeBottom }}
          showsVerticalScrollIndicator={false}
          contentInsetAdjustmentBehavior="never"
        >
          {/* Display headline + secondary actions — wrapped in a soft glass backdrop. */}
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <GlassFrostedCard
              radius={radius.card}
              style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <Text style={{ ...type.displayXL, color: t.ink }}>
                  {weekdayLine}
                  {'\n'}
                  {dateLine}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.xs }}>
                  {(pageIndex !== WEEKS_BEFORE || !isSelectedToday) && (
                    <Pressable onPress={jumpToToday} hitSlop={8}>
                      <Text style={{
                        fontFamily: fonts.ui,
                        fontSize: type.bodySm.fontSize,
                        color: t.ink3,
                      }}>
                        I dag
                      </Text>
                    </Pressable>
                  )}
                  {hasProvider && (
                    <Pressable
                      onPress={() => setPickerOpen(true)}
                      hitSlop={8}
                      style={{
                        paddingHorizontal: spacing.sm,
                        paddingVertical: spacing.xs,
                        borderRadius: radius.pill,
                        backgroundColor: surface.iconButton,
                      }}
                    >
                      <Text style={{
                        fontFamily: fonts.mono,
                        fontSize: type.eyebrow.fontSize,
                        letterSpacing: type.eyebrow.letterSpacing,
                        color: t.ink3,
                      }}>
                        KAL
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </GlassFrostedCard>
          </View>

          {/* Week-strip belt */}
          <View
            style={{ marginTop: spacing.lg, marginHorizontal: spacing.screenPad, overflow: 'hidden' }}
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
                  <WeekPage
                    key={wi}
                    week={week}
                    width={pageWidth}
                    onSelect={(date) => selectDay(date)}
                  />
                ))}
                {selectedPosition && (
                  <Animated.View
                    style={[
                      {
                        position: 'absolute',
                        left: 0,
                        top: (BELT_HEIGHT - 44) / 2,
                        height: 44,
                        borderRadius: radius.soft,
                        borderWidth: 1.5,
                        borderColor: t.ink,
                        width: stripPillWidth,
                      },
                      stripPillStyle,
                    ]}
                    pointerEvents="none"
                  />
                )}
              </ScrollView>
            )}
          </View>

          {/* Events / hour grid — wrapped in a glass card so the
              dayPanResponder swipe target sits on a backdrop instead
              of floating directly on the halo paper. */}
          <View
            style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.xl }}
            {...dayPanResponder.panHandlers}
          >
            <GlassFrostedCard
              radius={radius.card}
              style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}
            >
            <Text style={{ ...type.displayS, color: t.ink }}>
              {sectionTitle}
            </Text>
            <View style={{ height: 1, backgroundColor: t.ink, marginTop: spacing.xs }} />

            {!hasEvents ? (
              scheduleLoading && hasProvider && !scheduleError ? (
                <View>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <View
                      key={i}
                      style={[
                        { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', paddingVertical: spacing.md },
                        i > 0 && { borderTopWidth: 1, borderTopColor: t.line },
                      ]}
                    >
                      <Skeleton width={36} height={16} />
                      <View style={{ flex: 1, marginLeft: spacing.md }}>
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
              <View style={{ position: 'relative' }}>
                {slots.map((row, i) => (
                  <View
                    key={i}
                    style={[
                      { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', paddingVertical: spacing.md },
                      i > 0 && { borderTopWidth: 1, borderTopColor: t.line },
                    ]}
                    onLayout={(e) =>
                      onRowLayout(row.hour, e.nativeEvent.layout.y, e.nativeEvent.layout.height)
                    }
                  >
                    {/* Hour label */}
                    <Text style={{
                      width: 48,
                      fontFamily: fonts.mono,
                      fontSize: type.eyebrow.fontSize,
                      letterSpacing: type.eyebrow.letterSpacing,
                      color: row.event ? t.ink3 : t.ink4,
                      lineHeight: 22,
                    }}>
                      {row.hour}
                    </Text>
                    <View style={{ flex: 1 }}>
                      {row.event ? (
                        <View style={{
                          borderRadius: radius.cardSm,
                          paddingVertical: spacing.sm,
                          paddingHorizontal: spacing.md,
                          backgroundColor: toneColor(row.event.tone),
                          ...shadows.softCard,
                        }}>
                          {/* White on signal color — direction-agnostic chip text */}
                          <Text style={{ fontFamily: fonts.uiBold, fontSize: type.bodySm.fontSize, color: '#fff' }}>
                            {row.event.title}
                          </Text>
                          <Text style={{
                            fontFamily: fonts.mono,
                            fontSize: type.eyebrow.fontSize,
                            letterSpacing: type.eyebrow.letterSpacing,
                            color: 'rgba(255,255,255,0.85)',
                            marginTop: 1,
                          }}>
                            {row.event.sub}
                          </Text>
                        </View>
                      ) : (
                        <Text style={{ fontFamily: fonts.ui, fontSize: type.bodySm.fontSize, color: t.ink4 }}>
                          —
                        </Text>
                      )}
                    </View>
                  </View>
                ))}

                {/* Current-time indicator */}
                {showNowLine && (
                  <View
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: nowTop,
                      flexDirection: 'row',
                      alignItems: 'center',
                      zIndex: 10,
                    }}
                    pointerEvents="none"
                  >
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.today }} />
                    <View style={{ flex: 1, height: 1.5, backgroundColor: t.today }} />
                  </View>
                )}
              </View>
            )}
            </GlassFrostedCard>
          </View>
        </ScrollView>
      </View>

      <CalendarPickerSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} />
    </View>
  );
}

function WeekPage({
  week,
  width,
  onSelect,
}: {
  week: WeekStripDay[];
  width: number;
  onSelect: (date: Date) => void;
}) {
  const { t, fonts, radius, surface } = useTheme();

  // Belt is a single capsule across the row; cells share its width equally
  // minus the inset on each side. The active-day pill is rendered ABOVE the
  // strip at the parent level so it can spring across week boundaries when
  // the user pages forward and then taps a day in a different week.
  const innerWidth = width - BELT_INSET * 2;
  const cellWidth = innerWidth / week.length;

  const cells = (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
      {week.map((d, di) => (
        <Pressable
          key={di}
          onPress={() => onSelect(d.date)}
          style={({ pressed }) => [
            {
              width: cellWidth,
              height: BELT_HEIGHT - BELT_INSET * 2,
              alignItems: 'center' as const,
              justifyContent: 'center' as const,
            },
            pressed && !d.isSelected && { opacity: 0.55 },
          ]}
          hitSlop={4}
        >
          <Text style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            letterSpacing: 0.5,
            color: t.ink,
            opacity: d.isSelected || d.isToday ? 1 : 0.7,
          }}>
            {d.letter}
          </Text>
          <Text style={{
            marginTop: 2,
            fontFamily: fonts.display,
            fontSize: 20,
            lineHeight: 24,
            color: t.ink,
          }}>
            {d.num}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  const beltStyle = {
    height: BELT_HEIGHT,
    borderRadius: 16,
    overflow: 'hidden' as const,
    paddingHorizontal: BELT_INSET,
  };

  if (liquidGlassReady) {
    return (
      <View style={{ position: 'relative', width, height: BELT_HEIGHT, justifyContent: 'center' }}>
        <GlassView glassEffectStyle="regular" colorScheme="auto" style={beltStyle}>
          {cells}
        </GlassView>
      </View>
    );
  }

  return (
    <View style={{ position: 'relative', width, height: BELT_HEIGHT, justifyContent: 'center' }}>
      <View style={[beltStyle, { backgroundColor: surface.glass }]}>{cells}</View>
    </View>
  );
}
