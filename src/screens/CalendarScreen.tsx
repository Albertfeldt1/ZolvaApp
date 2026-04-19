import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { formatToday, weekStrip } from '../lib/date';
import { useDaySchedule, useHasProvider } from '../lib/hooks';
import type { CalendarSlot } from '../lib/types';
import { colors, fonts } from '../theme';

type EventTone = NonNullable<CalendarSlot['event']>['tone'];
const toneColor = (t: EventTone) =>
  t === 'sage' ? colors.sage : t === 'clay' ? colors.clay : colors.stone;

type Props = { onGoToSettings: () => void };

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function CalendarScreen({ onGoToSettings }: Props) {
  const today = useMemo(() => new Date(), []);
  const [selectedDate, setSelectedDate] = useState<Date>(today);
  const [weekAnchor, setWeekAnchor] = useState<Date>(today);

  const date = useMemo(() => formatToday(selectedDate), [selectedDate]);
  const strip = useMemo(
    () => weekStrip(weekAnchor, { today, selected: selectedDate }),
    [weekAnchor, today, selectedDate],
  );
  const isSelectedToday =
    selectedDate.getFullYear() === today.getFullYear() &&
    selectedDate.getMonth() === today.getMonth() &&
    selectedDate.getDate() === today.getDate();

  const { data: slots, error: scheduleError } = useDaySchedule(selectedDate);
  const hasEvents = slots.some((s) => s.event);
  const hasProvider = useHasProvider();
  const { bottom: chromeBottom } = useChromeInsets();

  const shiftWeek = (dir: -1 | 1) => {
    Haptics.selectionAsync();
    setWeekAnchor((prev) => addDays(prev, dir * 7));
  };

  const selectDay = (d: Date) => {
    Haptics.selectionAsync();
    setSelectedDate(d);
  };

  const jumpToToday = () => {
    Haptics.selectionAsync();
    setSelectedDate(today);
    setWeekAnchor(today);
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom }]}
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="never"
    >
      <View style={styles.hero}>
        <View style={styles.heroTopRow}>
          <Text style={styles.eyebrow}>{date.weekHeadline}</Text>
          {!isSelectedToday && (
            <Pressable onPress={jumpToToday} hitSlop={8}>
              <Text style={styles.todayLink}>I dag</Text>
            </Pressable>
          )}
        </View>
        <Text style={styles.heroH1}>{date.dayHeadline}</Text>

        <View style={styles.stripRow}>
          <Pressable onPress={() => shiftWeek(-1)} style={styles.weekArrow} hitSlop={8}>
            <ChevronLeft size={18} color={colors.ink} strokeWidth={1.75} />
          </Pressable>
          <View style={styles.dayStrip}>
            {strip.map((d, i) => (
              <Pressable
                key={i}
                onPress={() => selectDay(d.date)}
                style={({ pressed }) => [
                  styles.dayCell,
                  d.isSelected && styles.dayCellSelected,
                  d.isToday && !d.isSelected && styles.dayCellToday,
                  pressed && !d.isSelected && styles.dayCellPressed,
                ]}
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
          <Pressable onPress={() => shiftWeek(1)} style={styles.weekArrow} hitSlop={8}>
            <ChevronRight size={18} color={colors.ink} strokeWidth={1.75} />
          </Pressable>
        </View>
      </View>

      <View style={styles.list}>
        <Text style={styles.sectionTitle}>{isSelectedToday ? 'I dag' : date.weekdayFull}</Text>
        <View style={styles.inkRule} />
        {!hasEvents ? (
          hasProvider ? (
            <EmptyState
              mood="calm"
              title={scheduleError ? 'Kunne ikke hente kalender' : 'Ingen aftaler'}
              body={
                scheduleError
                  ? 'Din forbindelse er måske udløbet. Log ud og forbind igen.'
                  : isSelectedToday
                    ? 'Du har en rolig dag foran dig.'
                    : 'Ingen begivenheder på denne dag.'
              }
              ctaLabel={scheduleError ? 'Gå til indstillinger' : undefined}
              onCta={scheduleError ? onGoToSettings : undefined}
            />
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
          slots.map((row, i) => (
            <View key={i} style={[styles.row, i > 0 && styles.rowBorder]}>
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
          ))
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

  stripRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  weekArrow: {
    width: 28,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  dayStrip: { flex: 1, flexDirection: 'row', gap: 4, justifyContent: 'space-between' },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
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
});
