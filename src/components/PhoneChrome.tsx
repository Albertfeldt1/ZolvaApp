import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Bookmark, Calendar, Mail, Sun } from 'lucide-react-native';
import React, { createContext, useContext } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, shadows } from '../theme';
import { Stone } from './Stone';

// Dynamic bottom inset for screens so their scroll content always ends just
// above the tab bar, no matter what height the chrome actually renders at
// (taller on some devices, shorter on Android, grows with font scaling).
// App.tsx measures the chrome via onLayout and feeds it into this context.
type ChromeInsets = { bottom: number };
export const ChromeInsetsContext = createContext<ChromeInsets>({ bottom: 0 });
export function useChromeInsets(): ChromeInsets {
  return useContext(ChromeInsetsContext);
}

export type TabId = 'today' | 'inbox' | 'calendar' | 'memory' | 'settings';

const TABS: { id: Exclude<TabId, 'settings'>; label: string; Icon: typeof Sun }[] = [
  { id: 'today', label: 'I dag', Icon: Sun },
  { id: 'inbox', label: 'Indbakke', Icon: Mail },
  { id: 'calendar', label: 'Kalender', Icon: Calendar },
  { id: 'memory', label: 'Husk', Icon: Bookmark },
];

type Props = {
  active: TabId;
  onChange: (id: TabId) => void;
  onAskZolva: () => void;
  showAsk?: boolean;
  darkBg?: boolean;
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

export function PhoneChrome({ active, onChange, onAskZolva, showAsk = true, darkBg = false }: Props) {
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
            return (
              <Pressable key={id} style={styles.tab} onPress={() => onChange(id)}>
                <Icon size={20} color={color} strokeWidth={isActive ? 2.2 : 1.75} />
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
  tabLabel: { fontFamily: fonts.uiSemi, fontSize: 10 },
});
