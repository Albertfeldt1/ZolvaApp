import { GlassContainer, GlassView } from 'expo-glass-effect';
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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

// darkBg is accepted for API-shape parity with ClassicTabBar but intentionally
// unused — UIKit's colorScheme="auto" handles dark/light adaptation natively.
export function LiquidTabBar({ active, onChange, onAskZolva, showAsk = true }: Props) {
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
        <GlassView
          glassEffectStyle="regular"
          colorScheme="auto"
          style={styles.bar}
        >
          <View style={styles.tabsRow}>
            {TABS.map(({ id, label, Icon }) => {
              const isActive = active === id;
              const color = isActive ? colors.ink : colors.stone;
              return (
                <Pressable key={id} style={styles.tab} onPress={() => onChange(id)}>
                  {isActive && (
                    <GlassView
                      glassEffectStyle="clear"
                      tintColor="rgba(26,30,28,0.18)"
                      colorScheme="auto"
                      style={styles.activePill}
                      pointerEvents="none"
                    />
                  )}
                  <Icon size={20} color={color} strokeWidth={isActive ? 2.2 : 1.75} />
                  <Text style={[styles.tabLabel, { color }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </GlassView>
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
  bar: {
    marginHorizontal: 20,
    marginBottom: Platform.OS === 'ios' ? 24 : 14,
    borderRadius: 24,
    overflow: 'hidden',
  },
  tabsRow: {
    flexDirection: 'row',
    paddingTop: 8,
    paddingBottom: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 4,
    position: 'relative',
  },
  activePill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 8,
    right: 8,
    borderRadius: 999,
  },
  tabLabel: { fontFamily: fonts.uiSemi, fontSize: 10 },
});
