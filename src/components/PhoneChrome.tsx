import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Bookmark, Calendar, Mail, Sun } from 'lucide-react-native';
import React, { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import { ClassicTabBar } from './ClassicTabBar';
import { LiquidTabBar } from './LiquidTabBar';

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

export const TABS: { id: Exclude<TabId, 'settings'>; label: string; Icon: typeof Sun }[] = [
  { id: 'today', label: 'I dag', Icon: Sun },
  { id: 'inbox', label: 'Indbakke', Icon: Mail },
  { id: 'calendar', label: 'Kalender', Icon: Calendar },
  { id: 'memory', label: 'Husk', Icon: Bookmark },
];

export type PhoneChromeProps = {
  active: TabId;
  onChange: (id: TabId) => void;
  onAskZolva: () => void;
  showAsk?: boolean;
  darkBg?: boolean;
};

// isGlassEffectAPIAvailable guards iOS 26 beta builds that ship the
// component without the underlying API (expo issue #40911).
// isLiquidGlassAvailable checks component availability only — it does
// NOT check Reduce Transparency. UIKit's UIGlassEffectView degrades
// natively under Reduce Transparency to a translucent solid fill, the
// same way Apple's first-party apps do, so we let the OS handle that
// case instead of forcing the fallback.
const liquidGlassReady =
  Platform.OS === 'ios' &&
  isGlassEffectAPIAvailable() &&
  isLiquidGlassAvailable();

export function PhoneChrome(props: PhoneChromeProps) {
  return liquidGlassReady ? <LiquidTabBar {...props} /> : <ClassicTabBar {...props} />;
}
