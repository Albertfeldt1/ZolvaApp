# Liquid Glass Tab Bar — Design

**Date:** 2026-05-04
**Status:** Spec — pending implementation plan

## Problem

The current bottom tab bar (`src/components/PhoneChrome.tsx`) is a hand-rolled approximation of Apple's Liquid Glass: an `expo-blur` `BlurView` (`systemChromeMaterialLight/Dark`) under a three-stop `LinearGradient`, plus a 1px specular highlight and a hairline top edge. It looks "sloppy and weird" — the gradient and fake specular don't react to background content the way Apple's `UIGlassEffectView` does, the FAB sits as a separate solid pill with no visual relationship to the bar, and there's no morphing/refraction.

`expo-glass-effect` (~0.1.9) is already in `package.json` and unused. It exposes `GlassView` and `GlassContainer` which wrap iOS 26's native `UIGlassEffectView` — the actual Apple-made Liquid Glass material, with real refraction, edge specular, and container-driven morphing between adjacent glass elements.

## Goal

Replace the current bar with the real Liquid Glass material on iOS 26+, using `expo-glass-effect`. Keep the existing implementation as a fallback for iOS < 26 and Android. No change to navigation behavior, tab IDs, layout math, or `App.tsx` integration.

## Non-goals

- No change to `TabId`, `TABS`, `ChromeInsetsContext`, or any caller in `App.tsx`.
- No redesign of icons, labels, or tab order.
- No change to the screens themselves.
- No attempt to replicate Liquid Glass on Android or pre-iOS-26 — those keep the current look.
- No new haptics, animations, or interactions beyond what Liquid Glass gives natively.

## Architecture

`PhoneChrome.tsx` becomes a thin chooser. The current implementation moves to `ClassicTabBar.tsx`. A new `LiquidTabBar.tsx` renders the iOS 26 tree.

```
src/components/
├─ PhoneChrome.tsx          ← chooser + shared exports (TabId, TABS, ChromeInsetsContext)
├─ LiquidTabBar.tsx         ← NEW — iOS 26 GlassContainer / GlassView tree
└─ ClassicTabBar.tsx        ← extracted from current PhoneChrome.tsx body
```

`PhoneChrome.tsx` keeps owning:

- `TabId` type
- `TABS` constant (id, label, Icon)
- `ChromeInsetsContext` + `useChromeInsets()`
- The `Props` shape (`active`, `onChange`, `onAskZolva`, `showAsk`, `darkBg`)

so no caller in `App.tsx` changes. Both child components receive the same `Props` and the same `TABS`.

### Capability detection

```ts
import { Platform } from 'react-native';
import { isLiquidGlassAvailable, isGlassEffectAPIAvailable } from 'expo-glass-effect';

const liquidGlassReady =
  Platform.OS === 'ios' &&
  isGlassEffectAPIAvailable() &&  // guards iOS 26 beta crash (expo issue #40911)
  isLiquidGlassAvailable();        // checks component availability (NOT Reduce Transparency)
```

Computed once at module load — these are sync native checks, no React state needed. The chooser branches on this constant:

```tsx
export function PhoneChrome(props: Props) {
  return liquidGlassReady ? <LiquidTabBar {...props} /> : <ClassicTabBar {...props} />;
}
```

`ClassicTabBar` keeps the existing `darkBg` branch logic verbatim. `LiquidTabBar` ignores `darkBg` and uses `colorScheme="auto"` so UIKit picks light/dark from the system trait.

## LiquidTabBar visual structure

```
<View style={wrap}>                              ← layout wrapper, no glass
  <GlassContainer spacing={20}>                  ← morphs FAB ↔ bar specular
    {showAsk && (
      <GlassView                                 ← "Spørg Zolva" FAB
        glassEffectStyle="regular"
        isInteractive
        tintColor="rgba(26,30,28,0.55)"          ← ink tint, semi-transparent
        style={fab}                              ← rounded 999, self-end
      >
        <Pressable onPress={onAskZolva}>
          <Stone size={24} />
          <Text style={fabText}>Spørg Zolva</Text>
        </Pressable>
      </GlassView>
    )}
    <GlassView                                   ← the bar itself
      glassEffectStyle="regular"
      style={bar}                                ← rounded 24, marginH 20
    >
      <View style={tabsRow}>
        {TABS.map(({ id, label, Icon }) => {
          const isActive = active === id;
          return (
            <Pressable key={id} style={tab} onPress={() => onChange(id)}>
              {isActive && (
                <GlassView                       ← active-tab pill
                  glassEffectStyle="clear"
                  isInteractive
                  tintColor="rgba(26,30,28,0.18)"
                  style={activePill}
                  pointerEvents="none"
                />
              )}
              <Icon size={20} color={...} strokeWidth={isActive ? 2.2 : 1.75} />
              <Text style={tabLabel}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </GlassView>
  </GlassContainer>
</View>
```

### Why these choices

- **`GlassContainer` with `spacing={20}`** — the signature Liquid Glass effect: glass elements within `spacing` pt of each other have their specular highlights merge and their materials morph into one another. The FAB sits 12pt above the bar (its existing `marginBottom`), comfortably inside a 20pt threshold, so the morph engages at rest and stays continuous through any future spacing tweaks. This is the WWDC-2025 / Apple Music tab-bar look.
- **Bar `glassEffectStyle="regular"`** — `regular` is what Apple Music, Maps, and Photos use for their tab bars on iOS 26. `clear` is too transparent for a bar that floats over arbitrary content (today/inbox/calendar/memory all have wildly different backgrounds).
- **Active pill `glassEffectStyle="clear"` + ink tint** — `clear` material with a low-opacity ink tint gives the active tab a "lit-up" feel that reads as selection without competing with the bar's regular material. `pointerEvents="none"` so the pill doesn't intercept the Pressable's tap.
- **FAB inside the container as `GlassView`** — user chose option A. The FAB and bar morph as one shape when close, which is the defining Liquid Glass moment.
- **FAB `tintColor="rgba(26,30,28,0.55)"`** — keeps the ink-colored CTA identity from the current design, but as a tint over glass instead of a flat fill. High enough opacity that "Spørg Zolva" stays high-contrast.
- **`isInteractive` on FAB only** — the FAB is the only element the user taps directly. The active pill is purely decorative (`pointerEvents="none"`); the surrounding `Pressable` owns its tap and animation, so adding `isInteractive` to the pill would risk a competing UIKit press animation. Inactive tabs use plain `Pressable` (no per-tab glass).
- **`colorScheme="auto"`** — the only `darkBg` consumer today is the chat screen background. UIKit's auto adaptation handles this correctly because `regular` glass already darkens appropriately under dark content.

## Color & typography

- Active tab text/icon color: `colors.ink` (light mode) — UIKit will tint appropriately under dark mode via the auto color scheme. No conditional needed in JS.
- Inactive tab text/icon color: `colors.stone`.
- Same `fonts.uiSemi`, same 10pt label, same icon strokeWidths (2.2 active / 1.75 inactive).
- FAB text stays `colors.paper` on the ink-tinted glass.

## Layout

Same dimensions as the current bar so screen content (which uses `useChromeInsets()`) doesn't reflow:

- Bar: `marginHorizontal: 20`, `marginBottom: Platform.OS === 'ios' ? 24 : 14` (Android branch unreachable for `LiquidTabBar` but harmless), `borderRadius: 24`.
- Tab row: `paddingTop: 8`, `paddingBottom: 8`, each tab `flex: 1`.
- FAB: `alignSelf: 'flex-end'`, `marginRight: 20`, `marginBottom: 12`, `borderRadius: 999`, padding `12 / 18 / 10 / 18`.
- Active pill: absolutely positioned inside the tab Pressable, `borderRadius: 999`, sized to wrap icon + label with ~6pt horizontal and ~4pt vertical padding.

`GlassView` accepts standard `ViewProps` so all of this works directly.

## Fallback (`ClassicTabBar`)

Pure code-move from the existing `PhoneChrome.tsx`. No behavior change. Keeps `BlurView` + `LinearGradient` + `specular` + `topEdge` + `darkBg` branch as-is. This is the iOS < 26 / Android path and we explicitly do not redesign it — users on those platforms see exactly what shipped before.

## Testing

This is presentation-only; no logic to unit-test. Verification is visual on a dev build:

1. **iOS 26 device or simulator** — confirm `LiquidTabBar` renders, FAB and bar morph when scrolling content moves under them, active-tab pill appears on selection, tap animations feel native.
2. **iOS < 26 simulator** — confirm `ClassicTabBar` renders (current look), no `GlassView` errors in console.
3. **Android** — confirm `ClassicTabBar` renders.
4. **Reduce Transparency on (iOS 26)** — our chooser does NOT branch on this; UIKit degrades `UIGlassEffectView` natively to a translucent solid fill (matches Apple's first-party apps). Verify in Settings → Accessibility → Display & Text Size that the resulting bar still reads well. If it doesn't, follow-up: subscribe to `AccessibilityInfo.reduceTransparencyChanged` and force `ClassicTabBar` when the setting is on.
5. **Dark / light system theme** — switch system appearance, confirm both branches adapt.
6. **All five tab targets** — today, inbox, calendar, memory, settings — open each, confirm bar reads well over each background.
7. **Chat screen** — uses `darkBg=true` today. On Liquid branch, confirm `colorScheme="auto"` glass still reads well over the dark chat background. If contrast is poor, fall back to `colorScheme="dark"` for the chat-screen invocation.

No automated tests added — `expo-glass-effect` is a native UI module with no JS-level behavior to assert.

## Risks & mitigations

- **`expo-glass-effect` 0.1.x is pre-1.0.** API could change. Mitigation: pin the version, both `isGlassEffectAPIAvailable()` and `isLiquidGlassAvailable()` are part of the public API specifically for runtime safety, and the fallback path is the entire current implementation so a regression is recoverable by removing the chooser.
- **iOS 26 beta crash** (expo issue #40911). Mitigation: `isGlassEffectAPIAvailable()` is the documented guard.
- **Glass over the chat screen's dark background.** May need `colorScheme="dark"` instead of `auto` when `darkBg` is true. Decided at test step 7 — code allows it via the same `darkBg` prop already wired through.
- **Tap target on active pill.** `pointerEvents="none"` on the pill prevents it from swallowing touches; the surrounding `Pressable` keeps the full hit area.

## Files

**New:**
- `src/components/LiquidTabBar.tsx` — iOS 26 implementation.
- `src/components/ClassicTabBar.tsx` — extracted current implementation.

**Modified:**
- `src/components/PhoneChrome.tsx` — slimmed to chooser + shared exports (`TabId`, `TABS`, `ChromeInsetsContext`, `useChromeInsets`, `Props`).

**Unchanged:**
- `App.tsx` and every screen.
- `package.json` — `expo-glass-effect` already installed.

## Open questions resolved

- **Material:** `regular` for the bar, `clear` for the active pill.
- **FAB:** option A — `GlassView` inside the container, ink-tinted.
- **Active indicator:** tinted `clear` glass pill behind the active icon+label.
- **Dark mode:** `colorScheme="auto"`, revisit only if chat-screen contrast fails test step 7.
