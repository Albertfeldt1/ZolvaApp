// Papir day-timeline: every hour labelled, a gridline per hour, and a single
// continuous rail that fills (terracotta) up to NOW so you can see how far into
// the day you are — with a pulsing now-node. Ported from the prototype
// reference; root is a plain View (the parent screen owns the scroll).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { papirColor, papirFont } from '../../design/papir';

const HOUR_HEIGHT = 64; // px per hour — the whole scale derives from this
const RAIL_X = 58; // rail x-position (after the time column)
const NODE = 11; // hour-node diameter

export type TimelineEvent = {
  id: string;
  start: number; // decimal hour (e.g. 13.92)
  end?: number;
  title: string;
  place?: string;
};

type Props = {
  events: TimelineEvent[];
  /** Visible hour window. Parent expands it to cover out-of-range events. */
  startHour?: number;
  endHour?: number;
  /** Fill the rail / show the now-node — only meaningful for "today". */
  showNow?: boolean;
  now?: Date;
};

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
  // Re-render every 30s so the rail grows in real time.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!showNow) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [showNow]);

  const yFor = (decimalHour: number) => (decimalHour - startHour) * HOUR_HEIGHT;

  const now = nowProp ?? new Date();
  const nowDecimal = now.getHours() + now.getMinutes() / 60;
  const nowClamped = Math.min(Math.max(nowDecimal, startHour), endHour);
  const nowY = yFor(nowClamped);

  const totalHeight = (endHour - startHour) * HOUR_HEIGHT + 40;
  const hours = useMemo(
    () => Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i),
    [startHour, endHour],
  );

  const laidOut = useMemo(() => layoutColumns(events), [events]);

  // Soft pulse on the now-node.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!showNow) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, showNow]);
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });

  return (
    <View style={{ height: totalHeight, paddingTop: 8 }}>
      {/* Faint base rail (the whole day) */}
      <View style={[styles.rail, { top: 0, bottom: 16, backgroundColor: papirColor.line }]} />
      {/* Filled rail up to NOW */}
      {showNow ? <View style={[styles.rail, { top: 0, height: Math.max(nowY, 0), backgroundColor: papirColor.red }]} /> : null}

      {/* Hour rows: timestamp + gridline + node */}
      {hours.map((h) => {
        const y = yFor(h);
        const past = showNow && h <= nowDecimal;
        return (
          <View key={h} style={[styles.row, { top: y }]}>
            <Text style={[styles.hourLabel, past ? { color: papirColor.ink2 } : null]}>
              {String(h % 24).padStart(2, '0')}.00
            </Text>
            <View style={styles.gridline} />
            <View
              style={[
                styles.node,
                past
                  ? { backgroundColor: papirColor.red, borderColor: papirColor.red }
                  : { backgroundColor: papirColor.paper, borderColor: papirColor.line },
              ]}
            />
          </View>
        );
      })}

      {/* Events (clamped to the visible window; overlaps share the row 50/50) */}
      {laidOut.map(({ ev, col, cols }) => {
        const evEnd = ev.end ?? ev.start + 0.75;
        const clampedStart = Math.min(Math.max(ev.start, startHour), endHour);
        const clampedEnd = Math.min(Math.max(evEnd, startHour), endHour);
        if (clampedEnd <= startHour || clampedStart >= endHour) return null;
        const top = yFor(clampedStart);
        const height = Math.max((clampedEnd - clampedStart) * HOUR_HEIGHT - 10, 46);
        const half = cols === 2;
        return (
          <View
            key={ev.id}
            style={[
              styles.event,
              { top, height },
              // Overlapping pair: split the event area roughly 50/50 (offsets
              // are relative to parent width — close enough to the midpoint).
              half ? (col === 0 ? { right: '52%' } : { left: '50%' }) : null,
            ]}
          >
            <Text style={styles.eventTitle} numberOfLines={half ? 2 : 1}>
              {ev.title}
            </Text>
            {ev.place ? (
              <Text style={styles.eventPlace} numberOfLines={1}>
                {ev.place}
              </Text>
            ) : null}
          </View>
        );
      })}

      {/* Now-node with pulse + time pill */}
      {showNow ? (
        <View style={[styles.nowWrap, { top: nowY }]} pointerEvents="none">
          <Animated.View style={[styles.nowRing, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
          <View style={styles.nowDot} />
          <View style={styles.nowPill}>
            <Text style={styles.nowPillText}>
              {String(now.getHours()).padStart(2, '0')}.{String(now.getMinutes()).padStart(2, '0')}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    left: RAIL_X + NODE / 2 - 1,
    width: 2,
    borderRadius: 2,
    zIndex: 1,
  },
  row: {
    position: 'absolute',
    left: 0,
    right: 22,
    height: HOUR_HEIGHT,
    zIndex: 2,
  },
  hourLabel: {
    position: 'absolute',
    left: 0,
    top: -8,
    width: 46,
    fontFamily: papirFont.uiMedium,
    fontSize: 11,
    color: papirColor.ink3,
    fontVariant: ['tabular-nums'],
  },
  gridline: {
    position: 'absolute',
    left: RAIL_X + NODE + 8,
    right: 0,
    top: 0,
    height: 1,
    backgroundColor: papirColor.lineSoft,
  },
  node: {
    position: 'absolute',
    left: RAIL_X,
    top: -NODE / 2,
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    borderWidth: 2,
    zIndex: 3,
  },
  event: {
    position: 'absolute',
    left: RAIL_X + NODE + 14,
    right: 22,
    backgroundColor: papirColor.card,
    borderRadius: 13,
    borderLeftWidth: 3,
    borderLeftColor: papirColor.red,
    paddingVertical: 10,
    paddingHorizontal: 13,
    zIndex: 4,
    shadowColor: papirColor.ink,
    shadowOpacity: 0.04,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  eventTitle: { fontFamily: papirFont.uiSemi, fontSize: 14, color: papirColor.ink },
  eventPlace: { fontFamily: papirFont.ui, fontSize: 12, color: papirColor.ink2, marginTop: 3 },

  nowWrap: { position: 'absolute', left: RAIL_X + NODE / 2 - 8, zIndex: 6 },
  nowRing: {
    position: 'absolute',
    left: 0,
    top: -8,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: papirColor.red,
  },
  nowDot: {
    position: 'absolute',
    left: 1,
    top: -7,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: papirColor.red,
    borderWidth: 2.5,
    borderColor: papirColor.paper,
  },
  nowPill: {
    position: 'absolute',
    left: 22,
    top: -11,
    backgroundColor: papirColor.red,
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  nowPillText: {
    fontFamily: papirFont.uiBold,
    fontSize: 11,
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
});
