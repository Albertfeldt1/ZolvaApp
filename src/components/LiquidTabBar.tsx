import { GlassContainer, GlassView } from 'expo-glass-effect';
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
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
// Horizontal inset of the pill within its tab cell. 10pt each side
// gives a snug hug around the icon+label without letting labels like
// "Indbakke" or "Kalender" clip.
const PILL_INSET = 10;
// How far the pill extends above and below the bar. Apple's iOS 26
// pill bumps out of the bar's vertical extent — the lens "bubble" feel.
const PILL_OVERHANG = 4;

// darkBg is accepted for API-shape parity with ClassicTabBar but intentionally
// unused — UIKit's colorScheme="auto" handles dark/light adaptation natively.
export function LiquidTabBar({ active, onChange, onAskZolva, showAsk = true }: Props) {
  const [rowWidth, setRowWidth] = useState(0);
  const tabWidth = rowWidth / TABS.length;
  const activeIndex = TABS.findIndex((t) => t.id === active);

  const pillX = useSharedValue(0);
  const pillW = useSharedValue(0);

  useEffect(() => {
    if (rowWidth === 0) return;
    const targetX = activeIndex * tabWidth + PILL_INSET;
    const targetW = Math.max(0, tabWidth - PILL_INSET * 2);
    // First measurement: snap to position so the pill appears under the
    // already-active tab instead of springing in from the left edge.
    if (pillW.value === 0) {
      pillX.value = targetX;
      pillW.value = targetW;
    } else {
      pillX.value = withSpring(targetX, PILL_SPRING);
      pillW.value = withSpring(targetW, PILL_SPRING);
    }
  }, [activeIndex, tabWidth, rowWidth, pillX, pillW]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.value }],
    width: pillW.value,
  }));

  return (
    <View style={styles.wrap}>
      <GlassContainer spacing={20} style={styles.container}>
        {showAsk && (
          <GlassView
            glassEffectStyle="regular"
            isInteractive
            tintColor="rgba(26,30,28,0.55)"
            colorScheme="auto"
            style={styles.fab}
          >
            <Pressable onPress={onAskZolva} style={styles.fabPressable}>
              <Stone size={24} />
              <Text style={styles.fabText}>Spørg Zolva</Text>
            </Pressable>
          </GlassView>
        )}
        {/* barAnchor is a regular View (no overflow:hidden) so the pill,
            which lives as a sibling of the bar, can protrude above and
            below the bar's vertical bounds — the iconic iOS 26 lens look. */}
        <View style={styles.barAnchor}>
          <GlassView
            glassEffectStyle="regular"
            colorScheme="auto"
            style={styles.bar}
          >
            <View
              style={styles.tabsRow}
              onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}
            >
              {TABS.map(({ id, label, Icon }) => {
                const isActive = active === id;
                const color = isActive ? colors.ink : colors.stone;
                return (
                  <Pressable key={id} style={styles.tab} onPress={() => onChange(id)}>
                    <Icon size={20} color={color} strokeWidth={isActive ? 2.2 : 1.75} />
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
              tintColor="rgba(26,30,28,0.18)"
              colorScheme="auto"
              style={[styles.activePill, pillStyle]}
              pointerEvents="none"
            />
          )}
        </View>
      </GlassContainer>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  container: {},
  fab: {
    alignSelf: 'flex-end',
    marginRight: 20,
    marginBottom: 12,
    borderRadius: 999,
    overflow: 'hidden',
  },
  fabPressable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 12,
    paddingRight: 18,
    paddingVertical: 10,
  },
  fabText: { fontFamily: fonts.uiSemi, fontSize: 13.5, color: colors.paper },
  // Margins live on the anchor (not on the bar GlassView) so the pill
  // sibling can absolute-position relative to a coordinate space that
  // matches the bar's footprint. Wider horizontal margins (vs the
  // previous 20pt) match Apple's iOS 26 reference where the bar floats
  // as a narrower pill, not a near-edge-to-edge surface.
  barAnchor: {
    marginHorizontal: 48,
    marginBottom: Platform.OS === 'ios' ? 24 : 14,
  },
  // Fully pill-shaped bar (capsule). With 999 borderRadius, the corner
  // matches the active-pill's own 999 — both read as proper capsules.
  bar: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  // Thicker vertical padding so the bar reads as a substantial floating
  // capsule rather than a flat strip. Matches Apple's reference height.
  tabsRow: {
    flexDirection: 'row',
    paddingTop: 12,
    paddingBottom: 12,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  // Pill is a sibling of the bar, absolute-positioned within barAnchor.
  // Negative top/bottom let it extend beyond the bar's edges (protrusion).
  // translateX and width are driven by the spring above; left: 0 is base.
  activePill: {
    position: 'absolute',
    top: -PILL_OVERHANG,
    bottom: -PILL_OVERHANG,
    left: 0,
    borderRadius: 999,
  },
  tabLabel: { fontFamily: fonts.uiSemi, fontSize: 10 },
});
