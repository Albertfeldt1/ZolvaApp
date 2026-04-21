import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radii } from '../theme';

export type RibbonKind = 'meeting' | 'lunch' | 'focus';

export type RibbonEvent = {
  startHour: number;
  endHour: number;
  kind: RibbonKind;
  label: string;
};

const START_HOUR = 6;
const END_HOUR = 22;
const SPAN = END_HOUR - START_HOUR;

const colorOf = (k: RibbonKind) =>
  k === 'focus' ? colors.sage : k === 'lunch' ? colors.clay : colors.ink;

type Props = {
  events?: RibbonEvent[];
  now?: Date;
};

export function DayRibbon({ events = [], now }: Props) {
  const ticks = Array.from({ length: SPAN + 1 });

  const nowPct = useMemo(() => {
    const d = now ?? new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    if (h < START_HOUR || h > END_HOUR) return null;
    return ((h - START_HOUR) / SPAN) * 100;
  }, [now]);

  return (
    <View style={styles.wrap}>
      <View style={styles.track}>
        {ticks.map((_, i) => (
          <View
            key={i}
            style={[styles.tick, { left: `${(i / SPAN) * 100}%` }]}
          />
        ))}
        {events.map((e, i) => (
          <RibbonBlock key={i} event={e} index={i} />
        ))}
        {nowPct !== null && (
          <View style={[styles.nowLine, { left: `${nowPct}%` }]}>
            <View style={styles.nowDot} />
          </View>
        )}
        {events.length === 0 && (
          <View pointerEvents="none" style={styles.emptyOverlay}>
            <Text style={styles.emptyText}>Ingen planlagt tid</Text>
          </View>
        )}
      </View>
      <View style={styles.labels}>
        {['06', '10', '14', '18', '22'].map((h) => (
          <Text key={h} style={styles.label}>{h}</Text>
        ))}
      </View>
    </View>
  );
}

function RibbonBlock({ event, index }: { event: RibbonEvent; index: number }) {
  const scale = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(scale, {
      toValue: 1,
      duration: 500 + index * 120,
      delay: index * 100,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    }).start();
  }, [scale, index]);
  const clampedStart = Math.max(START_HOUR, event.startHour);
  const clampedEnd = Math.min(END_HOUR, event.endHour);
  if (clampedEnd <= clampedStart) return null;
  const width = `${((clampedEnd - clampedStart) / SPAN) * 100}%` as `${number}%`;
  const left = `${((clampedStart - START_HOUR) / SPAN) * 100}%` as `${number}%`;
  return (
    <Animated.View
      style={[
        styles.block,
        {
          left,
          width,
          backgroundColor: colorOf(event.kind),
          transform: [{ scaleX: scale }],
          opacity: scale,
        },
      ]}
    >
      <Text style={styles.blockText} numberOfLines={1}>{event.label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 16 },
  track: {
    position: 'relative',
    height: 44,
    backgroundColor: colors.mist,
    borderRadius: radii.r3,
    overflow: 'hidden',
  },
  tick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(26,30,28,0.06)',
  },
  block: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    borderRadius: 6,
    paddingHorizontal: 6,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  blockText: {
    color: colors.paper,
    fontSize: 10,
    fontFamily: fonts.uiSemi,
  },
  nowLine: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: 2,
    backgroundColor: colors.danger,
  },
  nowDot: {
    position: 'absolute',
    left: -4,
    top: -4,
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.danger,
  },
  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 11.5,
    letterSpacing: 0.3,
    color: colors.fg3,
  },
  labels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.fg3,
  },
});
