// Papir day-timeline, aligned with the approved 2026-07-07 mock: a quiet
// hour grid (label + hairline per hour), a single red now-line with a dot,
// and events as soft tinted cards with a deep accent bar. No rail, no hour
// nodes, no time pill — the grid itself carries the day. Root is a plain
// View (the parent screen owns the scroll).
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { papirColor, papirFont } from '../../design/papir';
import { useTabVisible } from '../../lib/tab-visibility';

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

const endOf = (ev: TimelineEvent) => ev.end ?? ev.start + 0.75;

/** Fuld kolonnetildeling (M15): events grupperes i klynger af transitivt
 * overlappende intervaller; inden for en klynge får hvert event den lavest
 * ledige kolonne (grådig interval-farvning), og hele klyngen deler bredden
 * på max-kolonnetallet. Tidligere alternerede vi bare mellem 2 kolonner, så
 * event nr. 3 i samme tidsrum blev tegnet OVENPÅ nr. 1. */
function layoutColumns(events: TimelineEvent[]): { ev: TimelineEvent; col: number; cols: number }[] {
  const sorted = [...events].sort((a, b) => a.start - b.start || endOf(b) - endOf(a));
  const out: { ev: TimelineEvent; col: number; cols: number }[] = [];
  let clusterFrom = 0; // indeks på klyngens første event i `out`
  let clusterEnd = -Infinity; // seneste sluttid i klyngen
  let colEnds: number[] = []; // pr. kolonne: sluttid for sidst placerede event

  const sealCluster = (to: number) => {
    const cols = Math.max(1, colEnds.length);
    for (let i = clusterFrom; i < to; i++) out[i].cols = cols;
  };

  sorted.forEach((ev) => {
    const s = ev.start;
    const e = endOf(ev);
    if (out.length > 0 && s >= clusterEnd) {
      sealCluster(out.length);
      clusterFrom = out.length;
      colEnds = [];
      clusterEnd = -Infinity;
    }
    let col = colEnds.findIndex((end) => s >= end);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(e);
    } else {
      colEnds[col] = Math.max(colEnds[col], e);
    }
    clusterEnd = Math.max(clusterEnd, e);
    out.push({ ev, col, cols: 1 });
  });
  sealCluster(out.length);
  return out;
}

export function DayTimeline({ events, startHour = 7, endHour = 22, showNow = true, now: nowProp }: Props) {
  // Re-render every 30s so the now-line moves in real time. Paused while
  // the hosting tab pane is hidden (battery); an immediate tick on return
  // snaps the line to the current time.
  const visible = useTabVisible();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!showNow || !visible) return;
    setTick((t) => t + 1);
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [showNow, visible]);

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

  // Målt bredde → kolonner kan lægges præcist i pixels uanset antal (M15).
  const [width, setWidth] = useState(0);
  const COL_GAP = 6;
  const areaLeft = GUTTER + CARD_INSET;
  const areaWidth = Math.max(0, width - areaLeft - 22);

  return (
    <View
      style={{ height: totalHeight, paddingTop: 8 }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {/* Hour rows: timestamp + hairline */}
      {hours.map((h) => (
        <View key={h} style={[styles.row, { top: yFor(h) }]}>
          <Text style={styles.hourLabel}>{String(h % 24).padStart(2, '0')}.00</Text>
          <View style={styles.gridline} />
        </View>
      ))}

      {/* Events (clamped to the visible window; overlap-klynger deler bredden
          ligeligt mellem klyngens kolonner) */}
      {width > 0 &&
        laidOut.map(({ ev, col, cols }, i) => {
          const duo = EVENT_DUOS[i % EVENT_DUOS.length];
          const evEnd = endOf(ev);
          const clampedStart = Math.min(Math.max(ev.start, startHour), endHour);
          const clampedEnd = Math.min(Math.max(evEnd, startHour), endHour);
          if (clampedEnd <= startHour || clampedStart >= endHour) return null;
          const top = yFor(clampedStart);
          const height = Math.max((clampedEnd - clampedStart) * HOUR_HEIGHT - 8, 56);
          const colWidth = areaWidth / cols;
          const left = areaLeft + col * colWidth;
          const cardWidth = colWidth - (col < cols - 1 ? COL_GAP : 0);
          const narrow = cols > 1;
          const meta = [ev.timeLabel, ev.place].filter(Boolean).join(' · ');
          return (
            <View
              key={ev.id}
              style={[
                styles.event,
                { top, height, backgroundColor: duo.soft, left, width: cardWidth, right: undefined },
              ]}
            >
              <View style={[styles.eventBar, { backgroundColor: duo.deep }]} />
              <View style={{ flex: 1, paddingVertical: 10, paddingRight: 12 }}>
                <Text style={[styles.eventTitle, { color: papirColor.ink }]} numberOfLines={narrow ? 2 : 1}>
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
