# Liquid Glass Tab Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current hand-rolled BlurView tab bar with the real iOS 26 Liquid Glass material via `expo-glass-effect`, while keeping the current implementation as a fallback for iOS < 26 and Android.

**Architecture:** `PhoneChrome.tsx` becomes a thin chooser that delegates to either `LiquidTabBar` (iOS 26+) or `ClassicTabBar` (everything else). Capability is detected once at module load using `isGlassEffectAPIAvailable()` + `isLiquidGlassAvailable()`. The Liquid branch wraps the FAB and bar in a single `GlassContainer` so they morph together (the signature WWDC-2025 effect); the active tab gets a tinted `clear`-style `GlassView` pill.

**Tech Stack:** React Native 0.81 / Expo 54, `expo-glass-effect` 0.1.9 (already installed), `expo-blur` (existing fallback), TypeScript, no test framework needed (presentation-only, visual verification on device).

**Spec:** `docs/superpowers/specs/2026-05-04-liquid-glass-tab-bar-design.md`

---

## File Structure

**New files:**
- `src/components/LiquidTabBar.tsx` — iOS 26 implementation using `GlassContainer` + `GlassView`.
- `src/components/ClassicTabBar.tsx` — extracted body of the current `PhoneChrome.tsx` (fallback path).

**Modified files:**
- `src/components/PhoneChrome.tsx` — slimmed to: shared exports (`TabId`, `TABS`, `Props`, `ChromeInsetsContext`, `useChromeInsets`) + the chooser that picks Liquid vs Classic.

**Unchanged:**
- `App.tsx` and every screen — they import `PhoneChrome`, `TabId`, `ChromeInsetsContext`, `useChromeInsets` from `./src/components/PhoneChrome`. All four exports remain at the same path with the same shape.

---

### Task 1: Extract current tab bar to `ClassicTabBar.tsx` (no behavior change)

**Files:**
- Create: `src/components/ClassicTabBar.tsx`
- Modify: `src/components/PhoneChrome.tsx`

This is a pure code-move. We carve the rendered output of the current `PhoneChrome` into a new component, then make `PhoneChrome` re-export it as a thin wrapper. No visual change, no logic change. This is the safe-rollback baseline before we add anything new.

- [ ] **Step 1: Create `src/components/ClassicTabBar.tsx` with the current implementation**

```tsx
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, shadows } from '../theme';
import { Stone } from './Stone';
import { TABS, TabId } from './PhoneChrome';

type Props = {
  active: TabId;
  onChange: (id: TabId) => void;
  onAskZolva: () => void;
  showAsk?: boolean;
  darkBg?: boolean;
};

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

export function ClassicTabBar({ active, onChange, onAskZolva, showAsk = true, darkBg = false }: Props) {
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
```

- [ ] **Step 2: Slim `src/components/PhoneChrome.tsx` to shared exports + chooser that delegates to `ClassicTabBar`**

Replace the entire contents of `src/components/PhoneChrome.tsx` with:

```tsx
import { Bookmark, Calendar, Mail, Sun } from 'lucide-react-native';
import React, { createContext, useContext } from 'react';
import { ClassicTabBar } from './ClassicTabBar';

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

export function PhoneChrome(props: PhoneChromeProps) {
  return <ClassicTabBar {...props} />;
}
```

Note `TABS` is now exported (it wasn't before) — `ClassicTabBar` and the upcoming `LiquidTabBar` both import it from here.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS, zero TypeScript errors. This proves the export shape (`PhoneChrome`, `TabId`, `ChromeInsetsContext`, `useChromeInsets`) didn't change for any caller.

- [ ] **Step 4: Visually confirm parity**

Boot a dev build (`npm run ios` or via the Expo dev client) and tap through Today / Inbox / Calendar / Memory tabs and the "Spørg Zolva" FAB. The bar must look pixel-identical to before — same blur, same gradient sheen, same active state, same FAB. If anything visually differs, the extraction is wrong.

- [ ] **Step 5: Commit**

```bash
git add src/components/ClassicTabBar.tsx src/components/PhoneChrome.tsx
git commit -m "refactor(tab-bar): extract ClassicTabBar from PhoneChrome

Pure code-move: PhoneChrome becomes a thin chooser that delegates
to ClassicTabBar. Exports TABS so future LiquidTabBar can share
the tab definitions. No visual or behavior change."
```

---

### Task 2: Add `LiquidTabBar.tsx` (iOS 26 Liquid Glass implementation)

**Files:**
- Create: `src/components/LiquidTabBar.tsx`

The Liquid Glass tree: a `GlassContainer` wrapping the FAB (`GlassView`, ink-tinted, interactive) and the bar (`GlassView`, regular). Inside the bar, each active tab gets a `clear`-style `GlassView` pill behind the icon+label with `pointerEvents="none"` so taps still hit the surrounding `Pressable`. We use `colorScheme="auto"` so UIKit handles dark/light. `darkBg` is accepted in props (for API compatibility with `ClassicTabBar`) but unused by this branch.

- [ ] **Step 1: Create `src/components/LiquidTabBar.tsx`**

```tsx
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
                      isInteractive
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
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. This validates that `expo-glass-effect`'s exported types match what we're using (`GlassView`, `GlassContainer`, `glassEffectStyle: 'regular' | 'clear'`, `tintColor`, `isInteractive`, `colorScheme`, `spacing`).

- [ ] **Step 3: Commit**

```bash
git add src/components/LiquidTabBar.tsx
git commit -m "feat(tab-bar): add LiquidTabBar component

iOS 26 Liquid Glass tab bar using expo-glass-effect. FAB and bar
share a GlassContainer so their materials morph together; active
tab gets a clear-style GlassView pill with ink tint. Not yet
wired into PhoneChrome — that's the next commit."
```

---

### Task 3: Wire `PhoneChrome` chooser to pick `LiquidTabBar` on iOS 26+

**Files:**
- Modify: `src/components/PhoneChrome.tsx`

Add the capability detection (`Platform.OS === 'ios' && isGlassEffectAPIAvailable() && isLiquidGlassAvailable()`) computed once at module load, and branch in the `PhoneChrome` function.

- [ ] **Step 1: Update `src/components/PhoneChrome.tsx` to add the chooser branch**

Replace the existing file with:

```tsx
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
// isLiquidGlassAvailable also returns false when the user has Reduce
// Transparency on in Accessibility settings — we honor that and fall
// back to ClassicTabBar.
const liquidGlassReady =
  Platform.OS === 'ios' &&
  isGlassEffectAPIAvailable() &&
  isLiquidGlassAvailable();

export function PhoneChrome(props: PhoneChromeProps) {
  return liquidGlassReady ? <LiquidTabBar {...props} /> : <ClassicTabBar {...props} />;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/PhoneChrome.tsx
git commit -m "feat(tab-bar): wire PhoneChrome to pick LiquidTabBar on iOS 26+

PhoneChrome now detects Liquid Glass capability at module load
(both isGlassEffectAPIAvailable and isLiquidGlassAvailable) and
delegates to LiquidTabBar on iOS 26+, ClassicTabBar everywhere
else (iOS < 26, Android, Reduce Transparency on)."
```

---

### Task 4: Visual verification across platforms and accessibility settings

**Files:** none modified. This is the verification gate the spec calls out. No code changes — if any check fails, file a follow-up against the spec.

- [ ] **Step 1: iOS 26 device or simulator — Liquid path**

Boot the app on iOS 26 (real device preferred for the GPU-accurate refraction). Walk through:
- Today / Inbox / Calendar / Memory tabs — each one renders the bar without artifacts.
- "Spørg Zolva" FAB — tappable, opens chat, and visibly morphs with the bar (specular highlights merge when scrolling content moves underneath).
- Active tab — the `clear` glass pill appears behind the active icon+label and animates on tap.
- Scroll content underneath the bar — refraction should distort the content visibly (this is the test for "real" Liquid Glass vs the old fake).

Expected: bar feels native (matches Apple Music, Maps, Photos on iOS 26).

- [ ] **Step 2: iOS < 26 simulator — Classic fallback**

Boot an iOS 17 or 18 simulator. Confirm:
- `ClassicTabBar` renders (BlurView + LinearGradient look — same as before this change).
- No `GlassView` warnings or errors in the Metro/Xcode console.
- All five tabs work, FAB works.

- [ ] **Step 3: Android — Classic fallback**

Boot an Android emulator. Confirm `ClassicTabBar` renders, no errors.

- [ ] **Step 4: Reduce Transparency on (iOS 26)**

On the iOS 26 device: Settings → Accessibility → Display & Text Size → Reduce Transparency → On. Re-launch the app (the capability check is module-load, so a JS reload is enough — shake device → Reload). Confirm `ClassicTabBar` renders (because `isLiquidGlassAvailable()` returns false). Turn it back off and reload — `LiquidTabBar` should be back.

- [ ] **Step 5: Dark mode**

Switch system appearance to dark on both an iOS 26 device (Liquid path) and an iOS < 26 device (Classic path). Confirm both bars adapt — Liquid via `colorScheme="auto"`, Classic via its existing `darkBg` prop pathway from callers.

- [ ] **Step 6: Chat screen contrast (Liquid path only)**

The chat screen passes `darkBg={true}` today. `LiquidTabBar` ignores `darkBg` and lets `colorScheme="auto"` handle it. Open the chat screen on iOS 26 and inspect the bar over the dark chat background:
- If contrast is acceptable (icons and labels readable, bar visually distinct from background): no change needed.
- If contrast is poor: open a follow-up to switch `LiquidTabBar` from `colorScheme="auto"` to a conditional `colorScheme={darkBg ? 'dark' : 'auto'}` on the bar's `GlassView`. The `darkBg` prop is already wired through, so the change is one line.

- [ ] **Step 7: Document results**

If everything passes, no further commits. If any step fails or surfaces a contrast issue per Step 6, open an issue or create a follow-up plan referencing this one — do not silently patch beyond what the spec authorized.

---

## Self-Review Notes

**Spec coverage:**
- Architecture (chooser pattern, capability detection, `LiquidTabBar` structure) → Tasks 1, 2, 3.
- `GlassContainer spacing={20}`, `regular` bar, `clear` active pill, FAB inside container with ink tint → Task 2.
- `colorScheme="auto"` + chat-screen contrast risk → Task 4 Step 6.
- Reduce Transparency handling → Task 4 Step 4.
- iOS 26 beta crash guard via `isGlassEffectAPIAvailable()` → Task 3.
- Layout dimensions preserved (so `useChromeInsets` math stays valid) → Task 2 styles match Task 1 styles.
- All callers in `App.tsx` unchanged → Task 1 Step 2 + Task 3 Step 1 keep `PhoneChrome`, `TabId`, `ChromeInsetsContext`, `useChromeInsets` exported from the same path with the same shape; `TABS` is newly exported but no existing caller needed it.

**Type consistency:**
- `Props`/`PhoneChromeProps` shape (`active`, `onChange`, `onAskZolva`, `showAsk?`, `darkBg?`) matches across `PhoneChrome`, `LiquidTabBar`, `ClassicTabBar`.
- `TabId` and `TABS` imported from `./PhoneChrome` in both child components.
- `glassEffectStyle: 'regular' | 'clear'`, `colorScheme: 'auto'`, `isInteractive`, `tintColor`, `spacing` all match `expo-glass-effect`'s `.d.ts` types.
- `Platform.OS === 'ios' ? 24 : 14` for `marginBottom` — same value in both `LiquidTabBar` and `ClassicTabBar` so layout doesn't shift between branches.

**No placeholders.**
