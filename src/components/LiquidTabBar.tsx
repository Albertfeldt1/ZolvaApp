import { GlassContainer, GlassView } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { colors, fonts } from '../theme';
import { Stone } from './Stone';
import { TABS, TabId } from './PhoneChrome';

type Props = {
  active: TabId;
  onChange: (id: TabId) => void;
  onAskZolva: () => void;
  showAsk?: boolean;
  darkBg?: boolean;
};

const AnimatedGlassView = Animated.createAnimatedComponent(GlassView);

// Spring tuned to match the iOS 26 system tab-bar feel: snappy but
// settles cleanly without overshoot looking spongy. Roughly Apple's
// UISpringTimingParameters defaults for the system pill.
const PILL_SPRING = { damping: 22, stiffness: 260, mass: 1 };
// Horizontal inset of the pill within its tab cell.
const PILL_INSET_H = 7;
// Vertical inset from the bar's top/bottom at rest. Smaller than the
// horizontal inset so the pill reads taller — closer to Apple's iOS 26
// lens proportions where the pill nearly fills the bar's height.
const PILL_INSET_V = 3;
// Peak overhang above/below the bar mid-transition. Pill returns to
// PILL_INSET_V at rest — only "pops" out during the spring move.
const PILL_OVERHANG_PEAK = 9;

// darkBg is accepted for API-shape parity with ClassicTabBar but intentionally
// unused — UIKit's colorScheme="auto" handles dark/light adaptation natively.
export function LiquidTabBar({ active, onChange, onAskZolva, showAsk = true }: Props) {
  const [rowWidth, setRowWidth] = useState(0);
  const tabWidth = rowWidth / TABS.length;
  const activeIndex = TABS.findIndex((t) => t.id === active);
  // Settings (and any other non-tab destination) returns -1 here. We
  // hide the pill in that case rather than letting it spring off-bar.
  const isVisible = activeIndex >= 0;

  const pillX = useSharedValue(0);
  const pillW = useSharedValue(0);
  // pillVertical drives both top and bottom: at rest = PILL_INSET_V
  // (small, so the pill reads tall within the bar). Mid-transition it
  // dips negative, briefly making the pill overhang the bar's edges.
  const pillVertical = useSharedValue(PILL_INSET_V);
  const pillOpacity = useSharedValue(isVisible ? 1 : 0);

  useEffect(() => {
    if (rowWidth === 0) return;
    if (!isVisible) {
      pillOpacity.value = withTiming(0, { duration: 160 });
      return;
    }
    const targetX = activeIndex * tabWidth + PILL_INSET_H;
    const targetW = Math.max(0, tabWidth - PILL_INSET_H * 2);
    pillOpacity.value = withTiming(1, { duration: 160 });
    // First measurement: snap to position so the pill appears under the
    // already-active tab instead of springing in from the left edge.
    if (pillW.value === 0) {
      pillX.value = targetX;
      pillW.value = targetW;
    } else {
      pillX.value = withSpring(targetX, PILL_SPRING);
      pillW.value = withSpring(targetW, PILL_SPRING);
      // Lens pop: pill briefly overhangs the bar (top/bottom go
      // negative), then settles back to the resting inset.
      pillVertical.value = withSequence(
        withTiming(-PILL_OVERHANG_PEAK, { duration: 150 }),
        withTiming(PILL_INSET_V, { duration: 240 })
      );
    }
  }, [activeIndex, tabWidth, rowWidth, isVisible, pillX, pillW, pillVertical, pillOpacity]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.value }],
    width: pillW.value,
    top: pillVertical.value,
    bottom: pillVertical.value,
    opacity: pillOpacity.value,
  }));

  // Stale-closure guard: PanResponder is created once but needs current
  // tabWidth + active. Keep them in a ref the handlers can read live.
  const slideRef = useRef({ tabWidth, active });
  useEffect(() => {
    slideRef.current = { tabWidth, active };
  }, [tabWidth, active]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Don't claim the gesture on initial touch — let Pressables tap.
        // Only take over once the user has clearly moved horizontally.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (e) => {
          const { tabWidth: tw, active: cur } = slideRef.current;
          if (tw <= 0) return;
          const x = e.nativeEvent.locationX;
          const idx = Math.max(
            0,
            Math.min(TABS.length - 1, Math.floor(x / tw))
          );
          const nextId = TABS[idx].id;
          if (nextId !== cur) {
            if (Platform.OS === 'ios') {
              Haptics.selectionAsync().catch(() => {});
            }
            onChange(nextId);
          }
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [onChange]
  );

  return (
    <View style={styles.wrap}>
      <GlassContainer spacing={20} style={styles.container}>
        {/* Row layout: bar expands to fill, FAB sits flush at the right
            edge at the same vertical level — mirrors the iOS Reminders
            "segmented control + search circle" pairing. */}
        <View style={styles.row}>
          {/* barAnchor has no overflow:hidden so the pill sibling can briefly
              protrude past the bar's vertical bounds during a tab switch. */}
          <View style={styles.barAnchor}>
            <GlassView
              glassEffectStyle="regular"
              colorScheme="auto"
              style={styles.bar}
            >
              <View
                style={styles.tabsRow}
                onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}
                {...panResponder.panHandlers}
              >
                {TABS.map(({ id, label, Icon }) => {
                  const isActive = active === id;
                  const color = isActive ? colors.ink : colors.stone;
                  return (
                    <Pressable key={id} style={styles.tab} onPress={() => onChange(id)}>
                      <Icon size={20} color={color} strokeWidth={isActive ? 1.7 : 1.4} />
                      <Text style={[styles.tabLabel, { color }]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </GlassView>
            {rowWidth > 0 && (
              <AnimatedGlassView
                glassEffectStyle="clear"
                isInteractive
                tintColor="rgba(255,255,255,0.30)"
                colorScheme="auto"
                style={[styles.activePill, pillStyle]}
                pointerEvents="none"
              />
            )}
          </View>
          {showAsk && (
            <GlassView
              glassEffectStyle="regular"
              isInteractive
              colorScheme="auto"
              style={styles.fab}
            >
              <Pressable
                onPress={onAskZolva}
                style={styles.fabPressable}
                accessibilityLabel="Spørg Zolva"
                accessibilityRole="button"
              >
                {/* Stone wraps itself in a Pressable to drive its hop
                    animation. Disable hit-testing on the inner view so the
                    outer Pressable receives the tap and onAskZolva fires
                    instead of the Stone's hop swallowing it. */}
                <View pointerEvents="none">
                  <Stone size={26} />
                </View>
              </Pressable>
            </GlassView>
          )}
        </View>
      </GlassContainer>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  container: {},
  // Bottom row: tab bar grows to fill the gap between the screen edge and
  // the FAB; FAB is a fixed-size circle on the right at the same vertical
  // baseline. Horizontal/bottom insets live here so both children share
  // the same coordinate space and render flush.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginLeft: 24,
    marginRight: 24,
    marginBottom: Platform.OS === 'ios' ? 24 : 14,
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 999,
    overflow: 'hidden',
  },
  fabPressable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bar takes the rest of the row's width. No own margins — the row owns
  // those. Pill siblings still absolute-position against this anchor.
  barAnchor: {
    flex: 1,
  },
  // Fully pill-shaped bar (capsule). With 999 borderRadius, the corner
  // matches the active-pill's own 999 — both read as proper capsules.
  bar: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  // Slightly tighter vertical padding so the bar/pill aspect reads as
  // landscape (wider than tall) rather than near-square.
  tabsRow: {
    flexDirection: 'row',
    paddingTop: 10,
    paddingBottom: 10,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  // Pill is a sibling of the bar, absolute-positioned within barAnchor.
  // top/bottom are driven by the overhang shared value (0 at rest, peaks
  // mid-transition). translateX and width are driven by the spring; left:
  // 0 is the base for the X transform.
  activePill: {
    position: 'absolute',
    left: 0,
    borderRadius: 999,
  },
  tabLabel: { fontFamily: fonts.uiSemi, fontSize: 10 },
});
