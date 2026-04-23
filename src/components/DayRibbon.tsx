import { MapPin, Users, X } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
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

const TRACK_COLLAPSED = 44;
const TRACK_EXPANDED = 176;
const TRACK_EXPANDED_DESC = 248;

const SPRING = { damping: 18, stiffness: 180, mass: 0.9 } as const;

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

function formatAttendees(list: RibbonAttendee[]): string {
  const names = list.map((a) => a.name || a.email || '').filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

// 3-line clamp will almost certainly hide content past this threshold.
function shouldOfferVisMere(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 180) return true;
  return (trimmed.match(/\n/g) ?? []).length >= 3;
}

type Props = {
  events?: RibbonEvent[];
  now?: Date;
};

export function DayRibbon({ events = [], now }: Props) {
  const ticks = Array.from({ length: SPAN + 1 });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);

  const nowPct = useMemo(() => {
    const d = now ?? new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    if (h < START_HOUR || h > END_HOUR) return null;
    return ((h - START_HOUR) / SPAN) * 100;
  }, [now]);

  const selectedIndex = useMemo(() => {
    if (!expandedId) return -1;
    return events.findIndex((e) => e.id === expandedId);
  }, [events, expandedId]);

  // Clear selection if the expanded event disappears (e.g. data refresh drops it).
  useEffect(() => {
    if (expandedId && selectedIndex === -1) setExpandedId(null);
  }, [expandedId, selectedIndex]);

  // Reset "Vis mere" when switching events so each opens in compact form.
  useEffect(() => {
    setDescExpanded(false);
  }, [expandedId]);

  const selectedEvent = selectedIndex >= 0 ? events[selectedIndex] : null;
  const hasDesc = !!selectedEvent?.description?.trim();

  const trackHeight = useSharedValue(TRACK_COLLAPSED);
  useEffect(() => {
    const target = !selectedEvent
      ? TRACK_COLLAPSED
      : descExpanded && hasDesc
        ? TRACK_EXPANDED_DESC
        : TRACK_EXPANDED;
    trackHeight.value = withSpring(target, SPRING);
  }, [selectedEvent, descExpanded, hasDesc, trackHeight]);

  const trackAnimStyle = useAnimatedStyle(() => ({ height: trackHeight.value }));

  const handlePress = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <View style={styles.wrap}>
      <Animated.View
        style={[styles.track, trackAnimStyle]}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
      >
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
            selectedIndex={selectedIndex}
            trackWidth={trackWidth}
            descExpanded={descExpanded}
            onPress={() => handlePress(e.id)}
            onClose={() => setExpandedId(null)}
            onToggleDesc={() => setDescExpanded((v) => !v)}
          />
        ))}
        {nowPct !== null && !selectedEvent && (
          <View style={[styles.nowLine, { left: `${nowPct}%` }]}>
            <View style={styles.nowDot} />
          </View>
        )}
        {events.length === 0 && (
          <View pointerEvents="none" style={styles.emptyOverlay}>
            <Text style={styles.emptyText}>Ingen planlagt tid</Text>
          </View>
        )}
      </Animated.View>
      <View style={styles.labels}>
        {['06', '10', '14', '18', '22'].map((h) => (
          <Text key={h} style={styles.label}>{h}</Text>
        ))}
      </View>
    </View>
  );
}

function RibbonBlock({
  event,
  index,
  selectedIndex,
  trackWidth,
  descExpanded,
  onPress,
  onClose,
  onToggleDesc,
}: {
  event: RibbonEvent;
  index: number;
  selectedIndex: number;
  trackWidth: number;
  descExpanded: boolean;
  onPress: () => void;
  onClose: () => void;
  onToggleDesc: () => void;
}) {
  const isSelected = selectedIndex === index;
  const hasSelection = selectedIndex !== -1;
  const isBefore = hasSelection && !isSelected && index < selectedIndex;

  const clampedStart = Math.max(START_HOUR, event.startHour);
  const clampedEnd = Math.min(END_HOUR, event.endHour);
  const durationOk = clampedEnd > clampedStart;

  const naturalLeft = durationOk ? ((clampedStart - START_HOUR) / SPAN) * trackWidth : 0;
  const naturalWidth = durationOk
    ? Math.max(8, ((clampedEnd - clampedStart) / SPAN) * trackWidth)
    : 0;

  // Off-screen distance. Any value larger than track width does the job —
  // track's overflow:hidden clips the translated block.
  const pushDistance = Math.max(trackWidth * 1.2, 400);

  const leftSV = useSharedValue(naturalLeft);
  const widthSV = useSharedValue(naturalWidth);
  const translateX = useSharedValue(0);
  const opacity = useSharedValue(1);
  const detailOpacity = useSharedValue(0);
  const titleOpacity = useSharedValue(1);

  useEffect(() => {
    if (trackWidth === 0) return;
    if (isSelected) {
      leftSV.value = withSpring(0, SPRING);
      widthSV.value = withSpring(trackWidth, SPRING);
      translateX.value = withSpring(0, SPRING);
      opacity.value = withTiming(1, { duration: 160 });
      titleOpacity.value = withTiming(0, { duration: 120 });
      detailOpacity.value = withTiming(1, { duration: 220 });
    } else if (hasSelection) {
      const direction = isBefore ? -1 : 1;
      translateX.value = withSpring(direction * pushDistance, SPRING);
      opacity.value = withTiming(0, { duration: 200 });
      detailOpacity.value = withTiming(0, { duration: 80 });
    } else {
      leftSV.value = withSpring(naturalLeft, SPRING);
      widthSV.value = withSpring(naturalWidth, SPRING);
      translateX.value = withSpring(0, SPRING);
      opacity.value = withTiming(1, { duration: 200 });
      titleOpacity.value = withTiming(1, { duration: 220 });
      detailOpacity.value = withTiming(0, { duration: 120 });
    }
  }, [
    isSelected,
    hasSelection,
    isBefore,
    naturalLeft,
    naturalWidth,
    trackWidth,
    pushDistance,
    leftSV,
    widthSV,
    translateX,
    opacity,
    titleOpacity,
    detailOpacity,
  ]);

  const wrapStyle = useAnimatedStyle(() => ({
    left: leftSV.value,
    width: widthSV.value,
    transform: [{ translateX: translateX.value }],
    opacity: opacity.value,
  }));
  const titleStyle = useAnimatedStyle(() => ({ opacity: titleOpacity.value }));
  const detailStyle = useAnimatedStyle(() => ({ opacity: detailOpacity.value }));

  if (!durationOk) return null;

  const bg = event.color ?? DEFAULT_COLOR;
  const fg = textOn(bg);
  const fgMuted = fg === colors.paper ? 'rgba(246,241,232,0.78)' : 'rgba(26,30,28,0.70)';

  return (
    <Animated.View style={[styles.blockWrap, wrapStyle]} pointerEvents="box-none">
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${event.title}, ${formatClock(event.start)} til ${formatClock(event.end)}`}
        accessibilityState={{ expanded: isSelected }}
        accessibilityHint={isSelected ? 'Tryk hvor som helst for at lukke' : undefined}
        hitSlop={isSelected ? undefined : { top: 6, bottom: 6, left: 2, right: 2 }}
        style={[
          styles.block,
          isSelected && styles.blockExpanded,
          { backgroundColor: bg },
        ]}
      >
        <Animated.Text
          style={[styles.blockText, { color: fg }, titleStyle]}
          numberOfLines={1}
          pointerEvents="none"
        >
          {event.title}
        </Animated.Text>

        {isSelected && (
          <Animated.View style={[styles.expanded, detailStyle]}>
            <View style={styles.expandedHead}>
              <Text style={[styles.expandedTitle, { color: fg }]} numberOfLines={2}>
                {event.title}
              </Text>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [
                  styles.closeBtn,
                  { backgroundColor: fg === colors.paper ? 'rgba(246,241,232,0.18)' : 'rgba(26,30,28,0.12)' },
                  pressed && { opacity: 0.6 },
                ]}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Luk"
              >
                <X size={14} color={fg} strokeWidth={2} />
              </Pressable>
            </View>
            <Text style={[styles.expandedTime, { color: fgMuted }]}>
              {formatClock(event.start)} – {formatClock(event.end)}
            </Text>
            {event.location && (
              <View style={styles.metaRow}>
                <MapPin size={12} color={fgMuted} strokeWidth={1.75} />
                <Text style={[styles.metaText, { color: fgMuted }]} numberOfLines={1}>
                  {event.location}
                </Text>
              </View>
            )}
            {event.attendees && event.attendees.length > 0 && (
              <View style={styles.metaRow}>
                <Users size={12} color={fgMuted} strokeWidth={1.75} />
                <Text style={[styles.metaText, { color: fgMuted }]} numberOfLines={2}>
                  {formatAttendees(event.attendees)}
                </Text>
              </View>
            )}
            {event.description && event.description.trim() && (
              <View style={styles.descWrap}>
                <Text
                  style={[styles.descText, { color: fg }]}
                  numberOfLines={descExpanded ? undefined : 3}
                >
                  {event.description.trim()}
                </Text>
                {shouldOfferVisMere(event.description) && (
                  <Pressable onPress={onToggleDesc} hitSlop={6}>
                    <Text style={[styles.descToggle, { color: fgMuted }]}>
                      {descExpanded ? 'Vis mindre' : 'Vis mere'}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </Animated.View>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 16 },
  track: {
    position: 'relative',
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
  blockExpanded: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: 'flex-start',
  },
  blockText: {
    fontSize: 10,
    fontFamily: fonts.uiSemi,
  },
  expanded: {
    ...StyleSheet.absoluteFillObject,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  expandedHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  expandedTitle: {
    flex: 1,
    fontFamily: fonts.uiSemi,
    fontSize: 15,
    lineHeight: 20,
  },
  closeBtn: {
    width: 24,
    height: 24,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -2,
  },
  expandedTime: {
    fontFamily: fonts.mono,
    fontSize: 11.5,
    letterSpacing: 0.4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaText: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 12.5,
  },
  descWrap: {
    marginTop: 2,
    gap: 4,
  },
  descText: {
    fontFamily: fonts.ui,
    fontSize: 12.5,
    lineHeight: 18,
  },
  descToggle: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
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
