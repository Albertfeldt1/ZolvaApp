import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, shadows } from '../theme';
import { Stone } from './Stone';
import { TABS, TabBadges, TabId } from './PhoneChrome';

type Props = {
  active: TabId;
  onChange: (id: TabId) => void;
  onAskZolva: () => void;
  showAsk?: boolean;
  darkBg?: boolean;
  badges?: TabBadges;
};

// iOS gets the real UIBlurEffect material (matches native tab-bar glass);
// Android falls back to the generic tint with experimental blur.
const LIGHT_BLUR_TINT = Platform.OS === 'ios' ? 'systemChromeMaterialLight' : 'light';
const DARK_BLUR_TINT = Platform.OS === 'ios' ? 'systemChromeMaterialDark' : 'dark';

const LIGHT_GRADIENT = [
  'rgba(255,255,255,0.28)',
  'rgba(246,241,232,0.08)',
  'rgba(246,241,232,0.14)',
] as const;
const DARK_GRADIENT = [
  'rgba(0,0,0,0.55)',
  'rgba(0,0,0,0.35)',
  'rgba(0,0,0,0.45)',
] as const;

export function ClassicTabBar({ active, onChange, onAskZolva, showAsk = true, darkBg = false, badges }: Props) {
  const activeColor = darkBg ? colors.paper : colors.ink;
  const inactiveColor = darkBg ? colors.paperOn75 : colors.stone;
  return (
    <View style={styles.wrap}>
      {showAsk && (
        <Pressable onPress={onAskZolva} style={styles.fab}>
          <Stone size={24} />
          <Text style={styles.fabText}>Spørg Zolva</Text>
        </Pressable>
      )}
      <View style={[styles.bar, darkBg && styles.barDark]}>
        <BlurView
          intensity={90}
          tint={darkBg ? DARK_BLUR_TINT : LIGHT_BLUR_TINT}
          experimentalBlurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={darkBg ? DARK_GRADIENT : LIGHT_GRADIENT}
          locations={[0, 0.55, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={[styles.specular, darkBg && styles.specularDark]} pointerEvents="none" />
        <View style={[styles.topEdge, darkBg && styles.topEdgeDark]} pointerEvents="none" />
        <View style={styles.tabsRow}>
          {TABS.map(({ id, label, Icon }) => {
            const isActive = active === id;
            const color = isActive ? activeColor : inactiveColor;
            const badgeCount = badges?.[id] ?? 0;
            return (
              <Pressable key={id} style={styles.tab} onPress={() => onChange(id)}>
                <View style={styles.iconWrap}>
                  <Icon size={20} color={color} strokeWidth={isActive ? 2.2 : 1.75} />
                  {badgeCount > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{badgeCount > 99 ? '99+' : badgeCount}</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.tabLabel, { color }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  fab: {
    alignSelf: 'flex-end',
    marginRight: 20,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 12,
    paddingRight: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.ink,
    ...shadows.fab,
  },
  fabText: { fontFamily: fonts.uiSemi, fontSize: 13.5, color: colors.paper },
  bar: {
    marginHorizontal: 20,
    marginBottom: Platform.OS === 'ios' ? 24 : 14,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'transparent',
    shadowColor: '#1A1E1C',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 28,
    elevation: 10,
  },
  barDark: {
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: '#000',
    shadowOpacity: 0.4,
  },
  specular: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  specularDark: {
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  topEdge: {
    position: 'absolute',
    top: 1,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(26,30,28,0.08)',
  },
  topEdgeDark: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  tabsRow: {
    flexDirection: 'row',
    paddingTop: 8,
    paddingBottom: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  iconWrap: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    fontFamily: fonts.uiSemi,
    fontSize: 9,
    color: '#fff',
    lineHeight: 16,
  },
  tabLabel: { fontFamily: fonts.uiSemi, fontSize: 10 },
});
