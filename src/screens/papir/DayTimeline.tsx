// Papir day-timeline, aligned with the approved 2026-07-07 mock: a quiet
// hour grid (label + hairline per hour), a single red now-line with a dot,
// and events as soft tinted cards with a deep accent bar. No rail, no hour
// nodes, no time pill — the grid itself carries the day. Root is a plain
// View (the parent screen owns the scroll).
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { papirColor, papirFont } from '../../design/papir';

const HOUR_HEIGHT = 76; // px per hour — the whole scale derives from this
const GUTTER = 56; // time-label column width; grid + events start after it
const CARD_INSET = 8; // extra indent of cards relative to the gridlines

export type TimelineEvent = {
  id: string;
  start: number; // decimal hour (e.g. 13.92)
  end?: number;
  title: string;
  place?: string;
  /** Preformatted "09.30–10.30" (parent has the real Dates — midnight-
   * crossing events would otherwise render a bogus "24.00"). */
  timeLabel?: string;
};

type Props = {
  events: TimelineEvent[];
  /** Visible hour window. Parent expands it to cover out-of-range events. */
  startHour?: number;
  endHour?: number;
  /** Show the red now-line — only meaningful for "today". */
  showNow?: boolean;
  now?: Date;
};

// Category duos (deep text/bar on soft surface) rotated per event — same
// trio as the Home ribbon. Deep-on-soft keeps them readable on paper.
const EVENT_DUOS = [
  { deep: papirColor.green, soft: papirColor.greenSoft },
  { deep: papirColor.slate, soft: papirColor.slateSoft },
  { deep: papirColor.rust, soft: papirColor.rustSoft },
] as const;

/** Assign overlapping events to two columns (simple alternating layout —
 * enough visual separation without a full interval-graph coloring). */
function layoutColumns(events: TimelineEvent[]): { ev: TimelineEvent; col: number; cols: number }[] {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const out: { ev: TimelineEvent; col: number; cols: number }[] = [];
  sorted.forEach((ev) => {
    const evEnd = ev.end ?? ev.start + 0.75;
    const prev = out[out.length - 1];
    if (prev) {
      const prevEnd = prev.ev.end ?? prev.ev.start + 0.75;
      if (ev.start < prevEnd && prev.ev.start < evEnd) {
        prev.cols = 2;
        out.push({ ev, col: prev.col === 0 ? 1 : 0, cols: 2 });
        return;
      }
    }
    out.push({ ev, col: 0, cols: 1 });
  });
  return out;
}

export function DayTimeline({ events, startHour = 7, endHour = 22, showNow = true, now: nowProp }: Props) {
  // Re-render every 30s so the now-line moves in real time.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!showNow) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [showNow]);

  const yFor = (decimalHour: number) => (decimalHour - startHour) * HOUR_HEIGHT;

  const now = nowProp ?? new Date();
  const nowDecimal = now.getHours() + now.getMinutes() / 60;
  const nowVisible = showNow && nowDecimal >= startHour && nowDecimal <= endHour;
  const nowY = yFor(nowDecimal);

  const totalHeight = (endHour - startHour) * HOUR_HEIGHT + 40;
  const hours = useMemo(
    () => Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i),
    [startHour, endHour],
  );

  const laidOut = useMemo(() => layoutColumns(events), [events]);

  return (
    <View style={{ height: totalHeight, paddingTop: 8 }}>
      {/* Hour rows: timestamp + hairline */}
      {hours.map((h) => (
        <View key={h} style={[styles.row, { top: yFor(h) }]}>
          <Text style={styles.hourLabel}>{String(h % 24).padStart(2, '0')}.00</Text>
          <View style={styles.gridline} />
        </View>
      ))}

      {/* Events (clamped to the visible window; overlaps share the row 50/50) */}
      {laidOut.map(({ ev, col, cols }, i) => {
        const duo = EVENT_DUOS[i % EVENT_DUOS.length];
        const evEnd = ev.end ?? ev.start + 0.75;
        const clampedStart = Math.min(Math.max(ev.start, startHour), endHour);
        const clampedEnd = Math.min(Math.max(evEnd, startHour), endHour);
        if (clampedEnd <= startHour || clampedStart >= endHour) return null;
        const top = yFor(clampedStart);
        const height = Math.max((clampedEnd - clampedStart) * HOUR_HEIGHT - 8, 56);
        const half = cols === 2;
        const meta = [ev.timeLabel, ev.place].filter(Boolean).join(' · ');
        return (
          <View
            key={ev.id}
            style={[
              styles.event,
              { top, height, backgroundColor: duo.soft },
              // Overlapping pair: split the event area roughly 50/50 (offsets
              // are relative to parent width — close enough to the midpoint).
              half ? (col === 0 ? { right: '52%' } : { left: '50%' }) : null,
            ]}
          >
            <View style={[styles.eventBar, { backgroundColor: duo.deep }]} />
            <View style={{ flex: 1, paddingVertical: 10, paddingRight: 12 }}>
              <Text style={[styles.eventTitle, { color: papirColor.ink }]} numberOfLines={half ? 2 : 1}>
                {ev.title}
              </Text>
              {meta ? (
                <Text style={[styles.eventMeta, { color: duo.deep }]} numberOfLines={1}>
                  {meta}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}

      {/* Now: a single red line with a dot at its left end */}
      {nowVisible ? (
        <View style={[styles.nowLineWrap, { top: nowY }]} pointerEvents="none">
          <View style={styles.nowDot} />
          <View style={styles.nowLine} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    left: 0,
    right: 22,
    height: HOUR_HEIGHT,
  },
  hourLabel: {
    position: 'absolute',
    left: 0,
    top: -8,
    width: GUTTER - 10,
    fontFamily: papirFont.uiMedium,
    fontSize: 12,
    color: papirColor.ink4,
    fontVariant: ['tabular-nums'],
  },
  gridline: {
    position: 'absolute',
    left: GUTTER,
    right: 0,
    top: 0,
    height: 1,
    backgroundColor: papirColor.lineSoft,
  },
  event: {
    position: 'absolute',
    left: GUTTER + CARD_INSET,
    right: 22,
    borderRadius: 14,
    flexDirection: 'row',
    overflow: 'hidden',
    zIndex: 2,
  },
  eventBar: {
    width: 4,
    borderRadius: 2,
    marginVertical: 6,
    marginLeft: 6,
    marginRight: 10,
  },
  eventTitle: { fontFamily: papirFont.uiSemi, fontSize: 15, letterSpacing: -0.1 },
  eventMeta: { fontFamily: papirFont.uiMedium, fontSize: 13, marginTop: 3, opacity: 0.85 },

  nowLineWrap: {
    position: 'absolute',
    left: GUTTER - 4,
    right: 22,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 3,
  },
  nowDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: papirColor.red,
  },
  nowLine: {
    flex: 1,
    height: 2,
    borderRadius: 1,
    backgroundColor: papirColor.red,
  },
});
