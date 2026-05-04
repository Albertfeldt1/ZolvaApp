import { GlassContainer, GlassView } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { liquidGlassReady } from '../lib/liquid-glass';
import { colors, fonts } from '../theme';

const AnimatedGlassView = Animated.createAnimatedComponent(GlassView);

// Same spring as LiquidTabBar so the two switchers feel like one system.
const PILL_SPRING = { damping: 22, stiffness: 260, mass: 1 };
const PILL_INSET_H = 4;
const PILL_INSET_V = 3;

export type LiquidTabItem<T extends string> = { id: T; label: string };

type Props<T extends string> = {
  tabs: ReadonlyArray<LiquidTabItem<T>>;
  active: T;
  onChange: (id: T) => void;
};

export function LiquidTabSwitcher<T extends string>({ tabs, active, onChange }: Props<T>) {
  const [rowWidth, setRowWidth] = useState(0);
  const tabWidth = rowWidth / tabs.length;
  const activeIndex = tabs.findIndex((t) => t.id === active);

  const pillX = useSharedValue(0);
  const pillW = useSharedValue(0);

  useEffect(() => {
    if (rowWidth === 0 || activeIndex < 0) return;
    const targetX = activeIndex * tabWidth + PILL_INSET_H;
    const targetW = Math.max(0, tabWidth - PILL_INSET_H * 2);
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

  // Stale-closure guard for pan handlers.
  const slideRef = useRef({ tabWidth, active });
  useEffect(() => {
    slideRef.current = { tabWidth, active };
  }, [tabWidth, active]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: (e) => {
          const { tabWidth: tw, active: cur } = slideRef.current;
          if (tw <= 0) return;
          const x = e.nativeEvent.locationX;
          const idx = Math.max(0, Math.min(tabs.length - 1, Math.floor(x / tw)));
          const nextId = tabs[idx].id;
          if (nextId !== cur) {
            if (Platform.OS === 'ios') Haptics.selectionAsync().catch(() => {});
            onChange(nextId);
          }
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [tabs, onChange]
  );

  const tabsRow = (
    <View
      style={styles.tabsRow}
      onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}
      {...panResponder.panHandlers}
    >
      {tabs.map(({ id, label }) => {
        const isActive = active === id;
        return (
          <Pressable key={id} style={styles.tab} onPress={() => onChange(id)}>
            <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (liquidGlassReady) {
    return (
      <View style={styles.wrap}>
        <GlassContainer spacing={6} style={styles.barAnchor}>
          <GlassView glassEffectStyle="regular" colorScheme="auto" style={styles.bar}>
            {tabsRow}
          </GlassView>
          {rowWidth > 0 && activeIndex >= 0 && (
            <AnimatedGlassView
              glassEffectStyle="clear"
              isInteractive
              tintColor="rgba(92,115,85,0.32)"
              colorScheme="auto"
              style={[styles.activePill, pillStyle]}
              pointerEvents="none"
            />
          )}
        </GlassContainer>
      </View>
    );
  }

  // Fallback for non-iOS-26: subtle sageSoft pill capsule with the same animated pill.
  return (
    <View style={styles.wrap}>
      <View style={[styles.barAnchor, styles.barFallback]}>
        {tabsRow}
        {rowWidth > 0 && activeIndex >= 0 && (
          <Animated.View
            style={[styles.activePill, styles.activePillFallback, pillStyle]}
            pointerEvents="none"
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  barAnchor: {
    position: 'relative',
  },
  bar: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  barFallback: {
    borderRadius: 999,
    backgroundColor: colors.mist,
    overflow: 'hidden',
  },
  tabsRow: {
    flexDirection: 'row',
    paddingVertical: 9,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  tabText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    letterSpacing: 0.4,
    color: colors.fg3,
    textTransform: 'uppercase',
  },
  tabTextActive: {
    color: colors.sageDeep,
  },
  activePill: {
    position: 'absolute',
    left: 0,
    top: PILL_INSET_V,
    bottom: PILL_INSET_V,
    borderRadius: 999,
  },
  activePillFallback: {
    backgroundColor: colors.sageSoft,
  },
});
