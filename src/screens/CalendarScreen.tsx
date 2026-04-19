import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
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

export function CalendarScreen({ onGoToSettings }: Props) {
  const today = useMemo(() => new Date(), []);
  const date = useMemo(() => formatToday(today), [today]);
  const strip = useMemo(() => weekStrip(today), [today]);

  const { data: slots, error: scheduleError } = useDaySchedule();
  const hasEvents = slots.some((s) => s.event);
  const hasProvider = useHasProvider();
  const { bottom: chromeBottom } = useChromeInsets();

  return (
    <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom }]} showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="never">
      <View style={styles.hero}>
        <View style={styles.heroTopRow}>
          <Text style={styles.eyebrow}>{date.weekHeadline}</Text>
        </View>
        <Text style={styles.heroH1}>{date.dayHeadline}</Text>

        <View style={styles.dayStrip}>
          {strip.map((d, i) => (
            <View
              key={i}
              style={[styles.dayCell, d.isToday && styles.dayCellToday]}
            >
              <Text style={[styles.dayLetter, d.isToday && styles.dayLetterToday]}>{d.letter}</Text>
              <Text style={[styles.dayNum, d.isToday && styles.dayNumToday]}>{d.num}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.list}>
        <Text style={styles.sectionTitle}>I dag</Text>
        <View style={styles.inkRule} />
        {!hasEvents ? (
          hasProvider ? (
            <EmptyState
              mood="calm"
              title={scheduleError ? 'Kunne ikke hente kalender' : 'Ingen aftaler i dag'}
              body={
                scheduleError
                  ? 'Din forbindelse er måske udløbet. Log ud og forbind igen.'
                  : 'Du har en rolig dag foran dig.'
              }
              ctaLabel={scheduleError ? 'Gå til indstillinger' : undefined}
              onCta={scheduleError ? onGoToSettings : undefined}
            />
          ) : (
            <EmptyState
              mood="calm"
              title="Ingen aftaler i dag"
              body="Forbind Google eller Outlook Kalender for at se din dagsplan."
              ctaLabel="Forbind kalender"
              onCta={onGoToSettings}
            />
          )
        ) : (
          slots.map((row, i) => (
            <View key={i} style={[styles.row, i > 0 && styles.rowBorder]}>
              <Text
                style={[
                  styles.hour,
                  !row.event && styles.hourDim,
                ]}
              >
                {row.hour}
              </Text>
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
  roundIcon: {
    width: 34, height: 34, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  heroH1: {
    marginTop: 10,
    fontFamily: fonts.displayItalic,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -1.08,
    color: colors.ink,
  },

  dayStrip: { marginTop: 16, flexDirection: 'row', gap: 6, justifyContent: 'space-between' },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 10,
  },
  dayCellToday: { backgroundColor: colors.ink },
  dayLetter: {
    fontFamily: fonts.mono, fontSize: 10,
    letterSpacing: 0.5, color: colors.ink, opacity: 0.7,
  },
  dayLetterToday: { color: colors.paper, opacity: 0.8 },
  dayNum: {
    marginTop: 2, fontFamily: fonts.display, fontSize: 20, lineHeight: 24, color: colors.ink,
  },
  dayNumToday: { color: colors.paper },

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
