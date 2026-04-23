import { MapPin, Users, X } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated as RNAnimated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeOutUp,
  LinearTransition,
} from 'react-native-reanimated';
import { colors, fonts, radii } from '../theme';

export type RibbonAttendee = {
  name?: string;
  email?: string;
};

export type RibbonEvent = {
  id: string;
  startHour: number;
  endHour: number;
  title: string;
  start: Date;
  end: Date;
  color?: string;
  location?: string;
  description?: string;
  attendees?: RibbonAttendee[];
};

const START_HOUR = 6;
const END_HOUR = 22;
const SPAN = END_HOUR - START_HOUR;
const DEFAULT_COLOR = '#3F51B5'; // Google Blueberry — matches calendar default

// Picks ink- or paper-tone for foreground text based on background luminance
// so small labels stay readable on both Banana and Tomato.
function textOn(bg: string): string {
  const hex = bg.replace('#', '');
  if (hex.length !== 6) return colors.paper;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 150 ? colors.ink : colors.paper;
}

function formatClock(d: Date): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}.${m}`;
}

type Props = {
  events?: RibbonEvent[];
  now?: Date;
};

export function DayRibbon({ events = [], now }: Props) {
  const ticks = Array.from({ length: SPAN + 1 });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);

  const nowPct = useMemo(() => {
    const d = now ?? new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    if (h < START_HOUR || h > END_HOUR) return null;
    return ((h - START_HOUR) / SPAN) * 100;
  }, [now]);

  const expandedEvent = useMemo(
    () => events.find((e) => e.id === expandedId) ?? null,
    [events, expandedId],
  );

  // Clear selection if the expanded event disappears from the list (e.g.,
  // data refresh drops it).
  useEffect(() => {
    if (expandedId && !expandedEvent) setExpandedId(null);
  }, [expandedId, expandedEvent]);

  // Reset "Vis mere" when switching events so each opens in compact form.
  useEffect(() => {
    setDescExpanded(false);
  }, [expandedId]);

  const handlePress = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <Animated.View style={styles.wrap} layout={LinearTransition.springify().damping(18)}>
      <View style={styles.track}>
        {ticks.map((_, i) => (
          <View
            key={i}
            style={[styles.tick, { left: `${(i / SPAN) * 100}%` }]}
          />
        ))}
        {events.map((e, i) => (
          <RibbonBlock
            key={e.id}
            event={e}
            index={i}
            selected={expandedId === e.id}
            dimmed={expandedId !== null && expandedId !== e.id}
            onPress={() => handlePress(e.id)}
          />
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
      {expandedEvent && (
        <Animated.View
          key={expandedEvent.id}
          style={[styles.card, { borderLeftColor: expandedEvent.color ?? DEFAULT_COLOR }]}
          entering={FadeInDown.duration(220).springify().damping(18)}
          exiting={FadeOutUp.duration(160)}
          layout={LinearTransition.springify().damping(18)}
        >
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle} numberOfLines={2}>{expandedEvent.title}</Text>
            <Pressable
              onPress={() => setExpandedId(null)}
              style={({ pressed }) => [styles.cardClose, pressed && { opacity: 0.6 }]}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Luk"
            >
              <X size={16} color={colors.fg3} strokeWidth={1.75} />
            </Pressable>
          </View>
          <Text style={styles.cardTime}>
            {formatClock(expandedEvent.start)} – {formatClock(expandedEvent.end)}
          </Text>
          {expandedEvent.location && (
            <View style={styles.cardMetaRow}>
              <MapPin size={13} color={colors.fg3} strokeWidth={1.75} />
              <Text style={styles.cardMeta} numberOfLines={1}>
                {expandedEvent.location}
              </Text>
            </View>
          )}
          {expandedEvent.attendees && expandedEvent.attendees.length > 0 && (
            <View style={styles.cardMetaRow}>
              <Users size={13} color={colors.fg3} strokeWidth={1.75} />
              <Text style={styles.cardMeta} numberOfLines={2}>
                {formatAttendees(expandedEvent.attendees)}
              </Text>
            </View>
          )}
          {expandedEvent.description && expandedEvent.description.trim() && (
            <View style={styles.cardDesc}>
              <Text
                style={styles.cardDescText}
                numberOfLines={descExpanded ? undefined : 3}
              >
                {expandedEvent.description.trim()}
              </Text>
              {shouldOfferVisMere(expandedEvent.description) && (
                <Pressable
                  onPress={() => setDescExpanded((v) => !v)}
                  hitSlop={6}
                >
                  <Text style={styles.cardDescToggle}>
                    {descExpanded ? 'Vis mindre' : 'Vis mere'}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        </Animated.View>
      )}
    </Animated.View>
  );
}

function formatAttendees(list: RibbonAttendee[]): string {
  const names = list.map((a) => a.name || a.email || '').filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

// Heuristic: if the description has >180 chars or >3 newlines, 3-line clamp
// will almost certainly hide content. Avoids rendering "Vis mere" on short
// one-liners where the toggle does nothing.
function shouldOfferVisMere(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 180) return true;
  return (trimmed.match(/\n/g) ?? []).length >= 3;
}

function RibbonBlock({
  event,
  index,
  selected,
  dimmed,
  onPress,
}: {
  event: RibbonEvent;
  index: number;
  selected: boolean;
  dimmed: boolean;
  onPress: () => void;
}) {
  const scale = useRef(new RNAnimated.Value(0)).current;
  useEffect(() => {
    RNAnimated.timing(scale, {
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
  const bg = event.color ?? DEFAULT_COLOR;
  const fg = textOn(bg);
  return (
    <RNAnimated.View
      style={[
        styles.blockWrap,
        {
          left,
          width,
          transform: [{ scaleX: scale }],
          opacity: dimmed ? 0.4 : scale,
        },
      ]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${event.title}, ${formatClock(event.start)} til ${formatClock(event.end)}`}
        accessibilityState={{ expanded: selected }}
        hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
        style={[
          styles.block,
          {
            backgroundColor: bg,
            borderColor: selected ? colors.ink : 'transparent',
            borderWidth: selected ? 1.5 : 0,
          },
        ]}
      >
        <Text style={[styles.blockText, { color: fg }]} numberOfLines={1}>
          {event.title}
        </Text>
      </Pressable>
    </RNAnimated.View>
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
  blockWrap: {
    position: 'absolute',
    top: 6,
    bottom: 6,
  },
  block: {
    flex: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  blockText: {
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

  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.paper,
    borderLeftWidth: 3,
    borderLeftColor: colors.ink,
    gap: 8,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 2,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  cardTitle: {
    flex: 1,
    fontFamily: fonts.uiSemi,
    fontSize: 15,
    lineHeight: 20,
    color: colors.ink,
  },
  cardClose: {
    width: 26,
    height: 26,
    borderRadius: 999,
    backgroundColor: 'rgba(26,30,28,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -2,
  },
  cardTime: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 0.4,
    color: colors.sageDeep,
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cardMeta: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 12.5,
    color: colors.fg3,
  },
  cardDesc: {
    marginTop: 2,
    gap: 4,
  },
  cardDescText: {
    fontFamily: fonts.ui,
    fontSize: 13,
    lineHeight: 19,
    color: colors.ink,
  },
  cardDescToggle: {
    fontFamily: fonts.uiSemi,
    fontSize: 12.5,
    color: colors.sageDeep,
  },
});
