# Visual Revamp — Phase 1: Foundation + Today (Glass & Air) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the design-system foundation (typed `theme`, fonts, Stone, Glass primitives) and migrate the Today screen end-to-end to the Glass & Air direction, pixel-perfect to the prototype, with all existing logic intact.

**Architecture:**
- New design system lives under `src/design/`. Old `src/theme.ts` and old components stay live and untouched until each consumer screen is migrated.
- Direction G is the only direction this phase cares about. Tokens for the other directions (A/B/C/D/E/F/H) ship as data but no UI swaps to them yet. The dev `Tweaks` panel and live re-keying ship in Phase 4.
- Halos: themeable at runtime via `<View backgroundColor=t.today opacity=…>` wrapped in a giant `<BlurView intensity=80>` — not pre-rendered PNGs.
- Stone: SVG via `react-native-svg`, animated via Reanimated v4 (API-compatible with the v3 snippet in `jump-motion.json`).
- Existing data flows in `TodayScreen` (`useTodayBrief`, reminders, upcoming events, notification counts) feed the new Glass markup verbatim — no refactor of the data layer.

**Tech Stack:** React Native 0.81, Expo SDK 54, expo-blur 15, expo-font 14, react-native-svg 15.12, react-native-reanimated 4.1, @expo-google-fonts/space-grotesk (new), existing @expo-google-fonts/inter and @expo-google-fonts/jetbrains-mono.

**Reference materials:**
- `/Users/albertfeldt/Downloads/handoff/tokens.json` — design tokens (8 directions)
- `/Users/albertfeldt/Downloads/handoff/stone/zolva-stone-{24,32,48,88,256}.svg` — production Stone SVG at 5 sizes
- `/Users/albertfeldt/Downloads/handoff/stone/jump-motion.json` — animation spec + Reanimated snippet
- `/Users/albertfeldt/Downloads/handoff/prototypes/screens-aesthetic.jsx` — `TodayGlass` reference (lines 95-195)
- `/Users/albertfeldt/Downloads/handoff/prototypes/shared.jsx` — `Icon`, `GlassTabBar`, `TopBar`, `Stone` web reference
- `/Users/albertfeldt/Downloads/handoff/RN_GOTCHAS.md` — CSS → RN substitutions

---

## File structure (Phase 1)

```
src/design/
  theme.ts                 ← typed tokens for all 8 directions + neutrals + type scale
  ThemeProvider.tsx        ← React context, defaults to direction 'G', persists to AsyncStorage
  useTheme.ts              ← hook (returns DirectionTokens flattened with neutrals + type)
  fonts.ts                 ← useDesignFonts() loads Space Grotesk + Inter + JetBrains Mono
  motion/
    useStoneJump.ts        ← Reanimated 4 hook (translateY/scaleX/scaleY)
  primitives/
    Stone.tsx              ← SVG-based, sizes 24/28/32/36/88, jumpOnTap default true
    Icon.tsx               ← sun/mail/cal/bookmark/bell/gear/plus/chev/send/sparkle/search/dot
    GlassFrostedCard.tsx   ← BlurView + translucent overlay + 1px white rim
    GlassHaloLayer.tsx     ← 4 absolute halos behind glass (today/mem positions)
    GlassTabBar.tsx        ← 4-tab pill + Spørg Zolva FAB above
    TopBar.tsx             ← eyebrow date + bell + gear

assets/stone/
  zolva-stone-24.svg
  zolva-stone-32.svg
  zolva-stone-48.svg
  zolva-stone-88.svg
  zolva-stone-256.svg

src/screens/
  TodayScreen.tsx          ← restyled in place (glass markup, same props/data)
```

---

## Task 1: Copy Stone SVG assets

**Files:**
- Create: `assets/stone/zolva-stone-24.svg`
- Create: `assets/stone/zolva-stone-32.svg`
- Create: `assets/stone/zolva-stone-48.svg`
- Create: `assets/stone/zolva-stone-88.svg`
- Create: `assets/stone/zolva-stone-256.svg`

- [ ] **Step 1: Copy SVGs from handoff folder**

```bash
mkdir -p assets/stone
cp /Users/albertfeldt/Downloads/handoff/stone/zolva-stone-{24,32,48,88,256}.svg assets/stone/
ls assets/stone/
```

Expected: 5 files listed.

- [ ] **Step 2: Verify SVGs parse**

```bash
head -3 assets/stone/zolva-stone-256.svg
```

Expected: starts with `<svg` or `<?xml`.

- [ ] **Step 3: Commit**

```bash
git add assets/stone/
git commit -m "chore(design): import Stone SVG assets for revamp"
```

---

## Task 2: Install Space Grotesk font package

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install package**

```bash
npm install @expo-google-fonts/space-grotesk
```

Expected: package added, no peer warnings.

- [ ] **Step 2: Verify import works**

```bash
node -e "console.log(Object.keys(require('@expo-google-fonts/space-grotesk')).filter(k => k.includes('500') || k.includes('600')))"
```

Expected output includes `SpaceGrotesk_500Medium` and `SpaceGrotesk_600SemiBold`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(design): add Space Grotesk font package"
```

---

## Task 3: Add `react-native-svg-transformer` for SVG-as-component imports

**Files:**
- Modify: `package.json`
- Modify: `metro.config.js` (create if missing)
- Modify: `tsconfig.json`
- Create: `declarations.d.ts`

**Why:** We import `zolva-stone-256.svg` as a React component. Without the transformer, we'd have to inline-paste SVG paths.

- [ ] **Step 1: Install dev dep**

```bash
npm install --save-dev react-native-svg-transformer
```

- [ ] **Step 2: Check whether metro.config.js exists**

```bash
ls metro.config.js 2>&1
```

If it exists, read it before editing. If not, create one in step 3.

- [ ] **Step 3: Create or extend `metro.config.js`**

Create file at repo root:

```js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.transformer = {
  ...config.transformer,
  babelTransformerPath: require.resolve('react-native-svg-transformer/expo'),
};
config.resolver = {
  ...config.resolver,
  assetExts: config.resolver.assetExts.filter((ext) => ext !== 'svg'),
  sourceExts: [...config.resolver.sourceExts, 'svg'],
};

module.exports = config;
```

- [ ] **Step 4: Add SVG type declaration**

Create `declarations.d.ts` at repo root:

```ts
declare module '*.svg' {
  import React from 'react';
  import { SvgProps } from 'react-native-svg';
  const content: React.FC<SvgProps>;
  export default content;
}
```

- [ ] **Step 5: Ensure `declarations.d.ts` is included in tsconfig**

Read `tsconfig.json`. If `include` exists, ensure `declarations.d.ts` is in it (or the existing glob already covers root `.d.ts` files). If not, add `declarations.d.ts` to `include`.

- [ ] **Step 6: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add metro.config.js declarations.d.ts tsconfig.json package.json package-lock.json
git commit -m "chore(design): wire react-native-svg-transformer for inline SVG imports"
```

---

## Task 4: Create typed theme tokens

**Files:**
- Create: `src/design/theme.ts`

- [ ] **Step 1: Write `src/design/theme.ts`**

```ts
// Design tokens for the Glass & Air revamp.
// Source: handoff/tokens.json. Direction G is the active default.

export type DirectionId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export type DirectionTokens = {
  id: DirectionId;
  name: string;
  paper: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  line: string;
  today: string;
  inbox: string;
  cal: string;
  mem: string;
  radius: number;
  radiusSm: number;
  mode: 'light' | 'dark';
  displayFontOverride?: string;
};

const inkScale = (ink: string) => {
  // Light directions: derive softer ink stops from black; dark directions
  // are overridden per-direction below.
  return {
    ink,
    ink2: '#3A3D43',
    ink3: '#7A7D84',
    ink4: '#B5B7BB',
    line: 'rgba(15,16,20,0.08)',
  };
};

export const directions: Record<DirectionId, DirectionTokens> = {
  A: { id: 'A', name: 'Vibrant Fills',   paper: '#FFFFFF', today: '#FF6B35', inbox: '#2D6CDF', cal: '#0E9F6E', mem: '#7C3AED', radius: 18, radiusSm: 14, mode: 'light', ink: '#0B0B0C', ...inkScale('#0B0B0C') },
  B: { id: 'B', name: 'Soft Saturation', paper: '#FFFFFF', today: '#FB923C', inbox: '#3B82F6', cal: '#10B981', mem: '#A855F7', radius: 14, radiusSm: 12, mode: 'light', ink: '#0B0B0C', ...inkScale('#0B0B0C') },
  C: { id: 'C', name: 'Bold Contrast',   paper: '#FFFFFF', today: '#F43F5E', inbox: '#0EA5E9', cal: '#84CC16', mem: '#9333EA', radius: 22, radiusSm: 16, mode: 'light', ink: '#0B0B0C', ...inkScale('#0B0B0C') },
  D: { id: 'D', name: 'Neutral + Pop',   paper: '#FFFFFF', today: '#FFD60A', inbox: '#1F4FFF', cal: '#00B894', mem: '#FF4F8B', radius: 12, radiusSm: 10, mode: 'light', ink: '#0B0B0C', ...inkScale('#0B0B0C') },
  E: { id: 'E', name: 'Twilight',        paper: '#0B0D11', today: '#FF7A66', inbox: '#7AB8FF', cal: '#A8E063', mem: '#C39BFF', radius: 16, radiusSm: 12, mode: 'dark',  ink: '#F5F4F0', ink2: 'rgba(245,244,240,0.8)', ink3: 'rgba(245,244,240,0.6)', ink4: 'rgba(245,244,240,0.35)', line: 'rgba(255,255,255,0.10)' },
  F: { id: 'F', name: 'Editorial Mono',  paper: '#FAFAF7', today: '#E64A2E', inbox: '#111111', cal: '#111111', mem: '#111111', radius: 4,  radiusSm: 4,  mode: 'light', ink: '#111111', ...inkScale('#111111'), displayFontOverride: 'PlayfairDisplay_500Medium_Italic' },
  G: { id: 'G', name: 'Glass & Air',     paper: '#FBFBFA', today: '#FF7A4D', inbox: '#FF7A4D', cal: '#FF9D6E', mem: '#B07AE0', radius: 24, radiusSm: 18, mode: 'light', ink: '#0F1014', ...inkScale('#0F1014') },
  H: { id: 'H', name: 'Card Stack',      paper: '#F2F1ED', today: '#D45A2E', inbox: '#3F6FB5', cal: '#5B8765', mem: '#8B6BBA', radius: 16, radiusSm: 12, mode: 'light', ink: '#1A1A1C', ...inkScale('#1A1A1C') },
};

export const DEFAULT_DIRECTION: DirectionId = 'G';

export const fontFamilies = {
  display: 'SpaceGrotesk_500Medium',
  displayBold: 'SpaceGrotesk_600SemiBold',
  ui: 'Inter_500Medium',
  uiBold: 'Inter_600SemiBold',
  uiRegular: 'Inter_400Regular',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_600SemiBold',
} as const;

export const typeScale = {
  displayXL: { fontSize: 44, lineHeight: 46, letterSpacing: -2,   fontFamily: fontFamilies.display    },
  displayL:  { fontSize: 34, lineHeight: 36, letterSpacing: -1.4, fontFamily: fontFamilies.displayBold },
  displayM:  { fontSize: 30, lineHeight: 34, letterSpacing: -1.2, fontFamily: fontFamilies.displayBold },
  displayS:  { fontSize: 24, lineHeight: 28, letterSpacing: -0.8, fontFamily: fontFamilies.displayBold },
  title:     { fontSize: 18, lineHeight: 22, letterSpacing: -0.3, fontFamily: fontFamilies.uiBold     },
  body:      { fontSize: 14, lineHeight: 20, letterSpacing: 0,    fontFamily: fontFamilies.ui         },
  bodySm:    { fontSize: 13, lineHeight: 18, letterSpacing: 0,    fontFamily: fontFamilies.ui         },
  caption:   { fontSize: 11.5, lineHeight: 16, letterSpacing: 0,  fontFamily: fontFamilies.ui         },
  eyebrow:   { fontSize: 10.5, lineHeight: 14, letterSpacing: 1.2, fontFamily: fontFamilies.mono, textTransform: 'uppercase' as const },
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 18, xl: 24, xxl: 32, screenPad: 18 } as const;
export const radius  = { sharp: 6, soft: 18, pill: 9999, card: 24, cardSm: 14 } as const;

export const stoneTokens = {
  body: '#6B8770',
  edge: '#3F5446',
  glow: '#8AA38C',
  rim: '#7E9A82',
  face: '#1a221d',
  shadowCast: 'rgba(60,90,70,0.35)',
} as const;
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/design/theme.ts
git commit -m "feat(design): typed token tree for 8 directions + type scale"
```

---

## Task 5: ThemeProvider + useTheme hook

**Files:**
- Create: `src/design/ThemeProvider.tsx`
- Create: `src/design/useTheme.ts`

- [ ] **Step 1: Write `src/design/ThemeProvider.tsx`**

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_DIRECTION, DirectionId, directions, DirectionTokens } from './theme';

type Ctx = {
  direction: DirectionId;
  setDirection: (d: DirectionId) => void;
  tokens: DirectionTokens;
};

export const ThemeContext = createContext<Ctx>({
  direction: DEFAULT_DIRECTION,
  setDirection: () => {},
  tokens: directions[DEFAULT_DIRECTION],
});

const STORAGE_KEY = '@zolva/design-direction';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [direction, setDirectionState] = useState<DirectionId>(DEFAULT_DIRECTION);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v && (v in directions)) setDirectionState(v as DirectionId);
    });
  }, []);

  const setDirection = (d: DirectionId) => {
    setDirectionState(d);
    AsyncStorage.setItem(STORAGE_KEY, d).catch(() => {});
  };

  const value = useMemo(
    () => ({ direction, setDirection, tokens: directions[direction] }),
    [direction],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
```

- [ ] **Step 2: Write `src/design/useTheme.ts`**

```ts
import { useContext } from 'react';
import { ThemeContext } from './ThemeProvider';
import { spacing, radius, typeScale, fontFamilies, stoneTokens } from './theme';

export function useTheme() {
  const { tokens, direction, setDirection } = useContext(ThemeContext);
  return {
    t: tokens,
    direction,
    setDirection,
    spacing,
    radius,
    type: typeScale,
    fonts: fontFamilies,
    stone: stoneTokens,
  };
}
```

- [ ] **Step 3: Wire ThemeProvider into App.tsx**

Read `App.tsx` at the root render point. Wrap the existing top-level `<View>` (or whichever element wraps `PhoneChrome`) in `<ThemeProvider>...</ThemeProvider>` from `./src/design/ThemeProvider`. Do NOT remove the existing colors theme — both run side-by-side until each screen migrates.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/design/ThemeProvider.tsx src/design/useTheme.ts App.tsx
git commit -m "feat(design): ThemeProvider + useTheme hook with persistence"
```

---

## Task 6: Load Space Grotesk fonts

**Files:**
- Create: `src/design/fonts.ts`
- Modify: `App.tsx`

- [ ] **Step 1: Write `src/design/fonts.ts`**

```ts
import { useFonts as useSpaceGrotesk, SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';

export function useDesignFonts() {
  const [loaded] = useSpaceGrotesk({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });
  return loaded;
}
```

- [ ] **Step 2: Add to App.tsx font-loading guard**

Read `App.tsx` and find where `useFraunces`/`useInter`/`useJetBrains`/`usePlayfair` results are AND'd to gate first render. Add `useDesignFonts()` to that gate.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Smoke-test on simulator**

```bash
npx expo start --ios --clear
```

Expected: App launches, no font-load errors in Metro logs.

- [ ] **Step 5: Commit**

```bash
git add src/design/fonts.ts App.tsx
git commit -m "feat(design): load Space Grotesk display font"
```

---

## Task 7: useStoneJump motion hook

**Files:**
- Create: `src/design/motion/useStoneJump.ts`

- [ ] **Step 1: Write the hook**

```ts
import { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

const SPRING_OUT = Easing.bezier(0.34, 1.56, 0.64, 1);

export function useStoneJump(size: number) {
  const ty = useSharedValue(0);
  const sx = useSharedValue(1);
  const sy = useSharedValue(1);
  const amp = -0.55 * size;

  const trigger = () => {
    sx.value = withSequence(
      withTiming(1.10, { duration: 90 }),
      withTiming(0.94, { duration: 120 }),
      withTiming(0.96, { duration: 150 }),
      withTiming(1.06, { duration: 120 }),
      withTiming(1.00, { duration: 120, easing: SPRING_OUT }),
    );
    sy.value = withSequence(
      withTiming(0.85, { duration: 90 }),
      withTiming(1.08, { duration: 120 }),
      withTiming(1.04, { duration: 150 }),
      withTiming(0.92, { duration: 120 }),
      withTiming(1.00, { duration: 120, easing: SPRING_OUT }),
    );
    ty.value = withSequence(
      withTiming(0,         { duration: 90 }),
      withTiming(amp,       { duration: 120 }),
      withTiming(amp * 0.55,{ duration: 150 }),
      withTiming(0,         { duration: 120 }),
      withTiming(0,         { duration: 120, easing: SPRING_OUT }),
    );
  };

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: ty.value },
      { scaleX: sx.value },
      { scaleY: sy.value },
    ],
  }));

  return { style, trigger };
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/design/motion/useStoneJump.ts
git commit -m "feat(design): Stone tap-jump animation hook (Reanimated 4)"
```

---

## Task 8: Stone primitive (SVG-based)

**Files:**
- Create: `src/design/primitives/Stone.tsx`

The new Stone replaces stacked-View-with-radial-gradients with a single inline SVG import per size, animated by `useStoneJump`. Sizes the app uses: 22, 24, 28, 32, 36, 88. The closest available SVG is selected at render.

- [ ] **Step 1: Write `Stone.tsx`**

```tsx
import React from 'react';
import { Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import Stone24 from '../../../assets/stone/zolva-stone-24.svg';
import Stone32 from '../../../assets/stone/zolva-stone-32.svg';
import Stone48 from '../../../assets/stone/zolva-stone-48.svg';
import Stone88 from '../../../assets/stone/zolva-stone-88.svg';
import Stone256 from '../../../assets/stone/zolva-stone-256.svg';
import { stoneTokens } from '../theme';
import { useStoneJump } from '../motion/useStoneJump';

type Props = {
  size?: number;
  jumpOnTap?: boolean;
  onPress?: () => void;
};

function pickSvg(size: number) {
  if (size <= 26) return Stone24;
  if (size <= 38) return Stone32;
  if (size <= 64) return Stone48;
  if (size <= 128) return Stone88;
  return Stone256;
}

export function Stone({ size = 32, jumpOnTap = true, onPress }: Props) {
  const { style, trigger } = useStoneJump(size);
  const Svg = pickSvg(size);

  const handlePress = () => {
    if (jumpOnTap) trigger();
    onPress?.();
  };

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={4}
      style={{
        width: size,
        height: size,
        // Soft green cast shadow
        shadowColor: '#5C7355',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
        elevation: 6,
      }}
    >
      <Animated.View style={[{ width: size, height: size }, style]}>
        <Svg width={size} height={size} />
      </Animated.View>
    </Pressable>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Visual smoke-test**

Add a temporary `<Stone size={88} />` somewhere visible (e.g. top of `TodayScreen.tsx` return) and run the app. Confirm SVG renders, tap triggers jump. Revert the temp render before committing.

- [ ] **Step 4: Commit**

```bash
git add src/design/primitives/Stone.tsx
git commit -m "feat(design): Stone primitive — SVG mascot with tap-jump"
```

---

## Task 9: Icon set

**Files:**
- Create: `src/design/primitives/Icon.tsx`

- [ ] **Step 1: Write `Icon.tsx` — port the SVG paths from `prototypes/shared.jsx` `Icon`**

```tsx
import React from 'react';
import { Path, Rect, Circle, Svg } from 'react-native-svg';

type IconProps = { size?: number; color: string };

const make = (paths: React.ReactNode) =>
  ({ size = 18, color }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      {paths}
    </Svg>
  );

export const Icon = {
  sun: make(<>
    <Circle cx={12} cy={12} r={4} />
    <Path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </>),
  mail: make(<>
    <Rect x={3} y={5} width={18} height={14} rx={2} />
    <Path d="M3 7l9 6 9-6" />
  </>),
  cal: make(<>
    <Rect x={3} y={5} width={18} height={16} rx={2} />
    <Path d="M3 9h18M8 3v4M16 3v4" />
  </>),
  bookmark: make(<Path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />),
  bell: make(<>
    <Path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9" />
    <Path d="M13.73 21a2 2 0 01-3.46 0" />
  </>),
  gear: make(<>
    <Circle cx={12} cy={12} r={3} />
    <Path d="M19.4 15a1.7 1.7 0 00.34 1.86l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.86-.34 1.7 1.7 0 00-1.04 1.55V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008.6 19.4a1.7 1.7 0 00-1.86.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.55-1.04H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 9 1.7 1.7 0 004.26 7.14l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6 1.7 1.7 0 0010.04 3.05V3a2 2 0 114 0v.1A1.7 1.7 0 0015.4 4.6a1.7 1.7 0 001.86-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9c0 .69.4 1.32 1.04 1.55H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1.04z" />
  </>),
  chev: make(<Path d="M9 6l6 6-6 6" />),
  plus: make(<Path d="M12 5v14M5 12h14" />),
  send: make(<Path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />),
  sparkle: make(<Path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />),
  search: make(<>
    <Circle cx={11} cy={11} r={7} />
    <Path d="M21 21l-4.3-4.3" />
  </>),
} as const;
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/design/primitives/Icon.tsx
git commit -m "feat(design): Icon set primitive (sun/mail/cal/bookmark/bell/gear/+8)"
```

---

## Task 10: GlassFrostedCard primitive

**Files:**
- Create: `src/design/primitives/GlassFrostedCard.tsx`

- [ ] **Step 1: Write `GlassFrostedCard.tsx`**

```tsx
import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, StyleProp, View, ViewStyle } from 'react-native';
import { useTheme } from '../useTheme';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  radius?: number;
  /** rgba overlay color above the blur — defaults to white 0.65 */
  overlay?: string;
};

export function GlassFrostedCard({ children, style, intensity = 45, radius, overlay = 'rgba(255,255,255,0.65)' }: Props) {
  const { radius: R } = useTheme();
  const r = radius ?? R.card;

  // On Android the BlurView is a no-op for older devices; the overlay
  // alone must be high enough opacity to read as glass. We bump it.
  const fallbackOverlay = Platform.OS === 'android' ? 'rgba(255,255,255,0.85)' : overlay;

  return (
    <View
      style={[
        {
          borderRadius: r,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.8)',
          shadowColor: '#0F1014',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.06,
          shadowRadius: 16,
          elevation: 2,
        },
        style,
      ]}
    >
      <BlurView intensity={intensity} tint="light" style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: fallbackOverlay }}>{children}</View>
      </BlurView>
    </View>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/design/primitives/GlassFrostedCard.tsx
git commit -m "feat(design): GlassFrostedCard primitive"
```

---

## Task 11: GlassHaloLayer primitive

**Files:**
- Create: `src/design/primitives/GlassHaloLayer.tsx`

- [ ] **Step 1: Write `GlassHaloLayer.tsx`**

Match the 4-halo positions used across all Glass screens (`screens-aesthetic.jsx` lines 99-102): top-left orange (today), top-right purple (mem), mid-left orange echo, bottom-right purple echo.

```tsx
import { BlurView } from 'expo-blur';
import React from 'react';
import { View } from 'react-native';
import { DirectionTokens } from '../theme';
import { useTheme } from '../useTheme';

type Halo = { top?: number; left?: number; right?: number; bottom?: number; size: number; color: keyof DirectionTokens; opacity: number };

const HALOS: Halo[] = [
  { top: -100, left: -80,  size: 340, color: 'today', opacity: 0.65 },
  { top: 40,   right: -110, size: 300, color: 'mem',   opacity: 0.55 },
  { top: 340,  left: -60,  size: 260, color: 'today', opacity: 0.35 },
  { bottom: 120, right: -60, size: 240, color: 'mem',   opacity: 0.35 },
];

export function GlassHaloLayer() {
  const { t } = useTheme();
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {HALOS.map((h, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            top: h.top,
            left: h.left,
            right: h.right,
            bottom: h.bottom,
            width: h.size,
            height: h.size,
            borderRadius: h.size / 2,
            backgroundColor: t[h.color] as string,
            opacity: h.opacity,
          }}
        />
      ))}
      {/* A single huge BlurView soft-focuses all halos, simulating filter:blur(80px) */}
      <BlurView intensity={80} tint="light" style={{ position: 'absolute', inset: 0 }} />
    </View>
  );
}
```

**Note:** RN doesn't accept `inset: 0` shorthand — it'll be ignored by the runtime. Use explicit `top: 0, left: 0, right: 0, bottom: 0` instead. Update the snippet:

Replace `style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}` with `style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}` and same for the BlurView.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/design/primitives/GlassHaloLayer.tsx
git commit -m "feat(design): GlassHaloLayer — themeable halo background"
```

---

## Task 12: TopBar primitive

**Files:**
- Create: `src/design/primitives/TopBar.tsx`

- [ ] **Step 1: Write `TopBar.tsx`**

Eyebrow text (mono, uppercase, letter-spacing 1.2) on the left; bell + gear icon buttons on the right (34×34 circular tinted backgrounds).

```tsx
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../useTheme';
import { Icon } from './Icon';

type Props = {
  eyebrow: string;
  onBell?: () => void;
  onGear?: () => void;
};

export function TopBar({ eyebrow, onBell, onGear }: Props) {
  const { t, type } = useTheme();
  const dark = t.mode === 'dark';
  const iconColor = dark ? 'rgba(255,255,255,0.7)' : t.ink2;
  const buttonBg = dark ? 'rgba(255,255,255,0.10)' : 'rgba(21,23,26,0.05)';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 56, paddingHorizontal: 20 }}>
      <Text style={{ ...type.eyebrow, color: dark ? 'rgba(255,255,255,0.65)' : t.ink3, fontWeight: '500' }}>
        {eyebrow}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable onPress={onBell} style={{ width: 34, height: 34, borderRadius: 9999, backgroundColor: buttonBg, alignItems: 'center', justifyContent: 'center' }}>
          <Icon.bell size={16} color={iconColor} />
        </Pressable>
        <Pressable onPress={onGear} style={{ width: 34, height: 34, borderRadius: 9999, backgroundColor: buttonBg, alignItems: 'center', justifyContent: 'center' }}>
          <Icon.gear size={16} color={iconColor} />
        </Pressable>
      </View>
    </View>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/design/primitives/TopBar.tsx
git commit -m "feat(design): TopBar primitive (eyebrow + bell + gear)"
```

---

## Task 13: GlassTabBar primitive

**Files:**
- Create: `src/design/primitives/GlassTabBar.tsx`

- [ ] **Step 1: Write `GlassTabBar.tsx`**

Two-row layout: FAB (Spørg Zolva, right-aligned, dark pill with mini Stone) above the bar; pill-shaped 4-tab bar centered below. Active tab gets a white inner pill with the tab's signal color tinting its icon + label.

```tsx
import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useTheme } from '../useTheme';
import { Icon } from './Icon';
import { Stone } from './Stone';

export type TabId = 'today' | 'inbox' | 'cal' | 'mem';

type Props = {
  active: TabId;
  onChange: (id: TabId) => void;
  onAskZolva: () => void;
  bottomInset: number;
};

export function GlassTabBar({ active, onChange, onAskZolva, bottomInset }: Props) {
  const { t, fonts } = useTheme();
  const dark = t.mode === 'dark';

  const TABS: { id: TabId; label: string; I: typeof Icon.sun; color: string }[] = [
    { id: 'today',  label: 'I dag',    I: Icon.sun,      color: t.today },
    { id: 'inbox',  label: 'Indbakke', I: Icon.mail,     color: t.inbox },
    { id: 'cal',    label: 'Kalender', I: Icon.cal,      color: t.cal },
    { id: 'mem',    label: 'Husk',     I: Icon.bookmark, color: t.mem },
  ];

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: bottomInset + 18, alignItems: 'center', gap: 10 }}>
      {/* FAB */}
      <View style={{ alignSelf: 'flex-end', marginRight: 48 }}>
        <Pressable
          onPress={onAskZolva}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            paddingVertical: 9, paddingLeft: 9, paddingRight: 14,
            borderRadius: 9999,
            backgroundColor: dark ? 'rgba(242,239,232,0.92)' : 'rgba(21,23,26,0.78)',
            shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 24, elevation: 8,
          }}
        >
          <Stone size={22} jumpOnTap={false} />
          <Text style={{ fontFamily: fonts.uiBold, fontSize: 13, color: dark ? '#0E1117' : '#fff', letterSpacing: -0.1 }}>
            Spørg Zolva
          </Text>
        </Pressable>
      </View>

      {/* Bar */}
      <View style={{
        width: '100%', marginHorizontal: 48,
        maxWidth: undefined,
      }}>
        <BlurView
          intensity={Platform.OS === 'ios' ? 70 : 60}
          tint={dark ? 'dark' : 'light'}
          style={{
            marginHorizontal: 48,
            borderRadius: 9999,
            overflow: 'hidden',
            shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.10, shadowRadius: 24, elevation: 6,
          }}
        >
          <View style={{
            flexDirection: 'row', padding: 8,
            backgroundColor: dark ? 'rgba(27,32,48,0.65)' : 'rgba(255,255,255,0.55)',
          }}>
            {TABS.map(tab => {
              const isActive = active === tab.id;
              const Ic = tab.I;
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => onChange(tab.id)}
                  style={{
                    flex: 1, alignItems: 'center', paddingVertical: 8,
                    borderRadius: 9999,
                    backgroundColor: isActive ? (dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.9)') : 'transparent',
                  }}
                >
                  <Ic size={20} color={isActive ? tab.color : t.ink3} />
                  <Text style={{ fontFamily: fonts.uiBold, fontSize: 10, color: isActive ? tab.color : t.ink3, marginTop: 2, letterSpacing: 0.1 }}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </BlurView>
      </View>
    </View>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/design/primitives/GlassTabBar.tsx
git commit -m "feat(design): GlassTabBar primitive (4 tabs + Spørg Zolva FAB)"
```

---

## Task 14: Migrate TodayScreen to Glass & Air

**Files:**
- Modify: `src/screens/TodayScreen.tsx`

This is the proof-of-concept that the design system is sound. Approach:

1. **Keep the entire props interface, all hooks, all data flows.** No refactor of `useTodayBrief`, reminder loading, ICS event fetch, etc.
2. **Replace the `return (` JSX** with the Glass markup (`TodayGlass` from `screens-aesthetic.jsx`).
3. **Replace styles** with theme-driven inline styles using `useTheme()`.
4. **Tab bar** at the bottom is now `GlassTabBar` — but App.tsx currently renders the tab bar at the App level. Decide: render `GlassTabBar` inside each screen (as the prototype does) OR replace the App-level tab bar. **Decision:** for Phase 1, pass through the existing App-level tab bar mechanism (don't render GlassTabBar inside TodayScreen yet). Phase 2 will replace the App-level `LiquidTabBar` with `GlassTabBar`. This keeps Phase 1 commits scoped.

- [ ] **Step 1: Inspect current `TodayScreen.tsx` props and data**

```bash
sed -n '73,115p' src/screens/TodayScreen.tsx
```

Note the props shape and which hooks fire. The existing screen consumes:
- `briefHook = useTodayBrief()` — gives counts (mails, meetings, reminders) and the brief text
- `reminders` — pending list
- `events` — upcoming events for the ribbon
- nav callbacks (onTabChange, onOpenInbox, onOpenCalendar, onOpenChat, onOpenSettings)

We map these to the Glass markup:
- `4 møder` → `events.length` (or count of events today)
- `7 mails venter` → mail count from brief
- `2 påmindelser` → `reminders.filter(isPending).length`
- "God morgen, Albert." → `greeting()` + user name
- Eyebrow "TIRSDAG · 5. MAJ" → `formatToday()`
- Hero card "Lige nu / 10:24" → current time
- Soft ribbon → derive from same `events` data the existing `DayRibbon` consumes

- [ ] **Step 2: Build the new Today JSX as a separate inner component**

Rather than ripping the whole file, define a new function `TodayGlassScreen` co-located in `TodayScreen.tsx`. Have the exported `TodayScreen` delegate to it. Keep the old JSX **deleted** (we're committing fully to the new design — leaving dead JSX is feedback flag #1).

- [ ] **Step 3: Write the Glass JSX**

Reference `screens-aesthetic.jsx:95-195` (`TodayGlass`). Translate to RN:
- `<div style={{...}}>` → `<View style={{...}}>`
- `backdropFilter: blur` → wrap content in `<BlurView>` or use `<GlassFrostedCard>`
- `radial-gradient` halos → `<GlassHaloLayer>`
- Display text → `<Text style={{...type.displayXL}}>`
- Mono eyebrow → `<Text style={{...type.eyebrow}}>`
- The frosted hero card with "4 / 7 / 2" stats → custom `<View>` with `<BlurView>` (this card has a custom stronger blur+border, not standard `GlassFrostedCard`)
- The 3 next-event rows → `<GlassFrostedCard>` with internal layout

Code skeleton (not pixel-final — measure against prototype during implementation):

```tsx
function TodayGlassContent({ brief, reminders, events, userName, ... }: Props) {
  const { t, type, fonts, spacing, radius } = useTheme();
  const insets = useChromeInsets();

  const meetingCount = events.length;
  const mailCount = brief?.counts?.mailsWaiting ?? 0;
  const reminderCount = reminders.filter(isPendingAndDueOrUpcoming).length;

  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <GlassHaloLayer />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 140 }}>
        <TopBar eyebrow={formatToday().toUpperCase()} onBell={onOpenNotifications} onGear={onOpenSettings} />
        <View style={{ paddingHorizontal: 22, paddingTop: 14 }}>
          <Text style={{ ...type.displayXL, fontFamily: fonts.display, color: t.ink }}>
            {greeting()},{'\n'}{userName}.
          </Text>
          <Text style={{ ...type.body, color: t.ink2, marginTop: 10, maxWidth: 300 }}>
            {meetingCount} møder, {mailCount} mails venter, og {reminderCount} {plural(reminderCount, 'påmindelse', 'påmindelser')}.
          </Text>
        </View>

        {/* Frosted hero stat card */}
        <View style={{ paddingHorizontal: 18, paddingTop: 22 }}>
          <BlurView intensity={50} tint="light" style={{ borderRadius: radius.card, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)' }}>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.55)', padding: 18 }}>
              {/* "Lige nu" eyebrow row */}
              {/* Big "4" + Møder, "7" + Mails, "2" + Påmindelser */}
              {/* Soft ribbon */}
            </View>
          </BlurView>
        </View>

        {/* 3 next-event rows */}
        <View style={{ paddingHorizontal: 18, paddingTop: 18, gap: 10 }}>
          {events.slice(0, 3).map((e) => (
            <GlassFrostedCard key={e.id} style={{ padding: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 }}>
                <View style={{ width: 6, alignSelf: 'stretch', borderRadius: 9999, backgroundColor: toneColor(e.tone) }} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                    <Text style={{ fontFamily: fonts.display, fontSize: 16, color: t.ink }}>{e.timeLabel}</Text>
                    <Text style={{ fontFamily: fonts.uiBold, fontSize: 13.5, color: t.ink }}>{e.title}</Text>
                  </View>
                  <Text style={{ ...type.caption, color: t.ink3, marginTop: 1 }}>{e.subtitle}</Text>
                </View>
                <Icon.chev size={14} color={t.ink4} />
              </View>
            </GlassFrostedCard>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
```

- [ ] **Step 4: Wire `TodayGlassContent` into the exported `TodayScreen`**

Replace the existing `return (...)` block with `<TodayGlassContent {...derivedProps} />`. Pass through all the hooks the original screen consumed; map their outputs to the new component's expected shape.

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 6: Run on simulator and compare to prototype**

```bash
npx expo start --ios --clear
```

Open the running app and the prototype side-by-side:

```bash
open /Users/albertfeldt/Downloads/handoff/prototypes/prototype.html
```

Walk through and compare:
- Eyebrow text + style
- Display headline size (44pt) and line-height (46)
- Body subtitle size + color
- Hero card blur intensity + border + radius
- Big number "4" rendering + Møder eyebrow
- Soft ribbon segments + colors
- Each next-event row spacing, time format, chev color

Adjust any visual mismatches in code. Iterate until the screens match.

- [ ] **Step 7: Commit**

```bash
git add src/screens/TodayScreen.tsx
git commit -m "feat(today): migrate to Glass & Air design"
```

---

## Task 15: Phase 1 final verification

- [ ] **Step 1: Typecheck clean**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 2: Tests pass**

```bash
npm test
```

Expected: passing or `--passWithNoTests` exits 0.

- [ ] **Step 3: Confirm Today screen renders pixel-close on iPhone 14 (390pt)**

Manual QA against `prototype.html` with the iPhone 14 viewport. Note any deviations in a follow-up task; minor (<2pt) drift is acceptable for Phase 1.

- [ ] **Step 4: Confirm tabs other than Today still render unchanged**

Tap each of Inbox / Calendar / Husk / Chat. They should render in the **old** sage-cream design. They will be migrated in Phase 2.

- [ ] **Step 5: Self-review of Phase 1 plan completion**

All Phase 1 tasks committed? `git log --oneline | head -20` should show ~14 commits since the worktree's base.

---

## Phases 2-5: outline (detailed plans to be written before each phase begins)

**Phase 2 — Migrate remaining 4 main tabs**
- Replace App-level tab bar with `GlassTabBar` (one commit; touches `App.tsx`, `PhoneChrome.tsx`).
- Inbox glass migration (one commit per screen).
- Calendar glass migration.
- Husk glass migration.
- Chat glass migration.

**Phase 3 — Extra screens (8)**
- Restyle: Settings, Notifications, Onboarding (existing wizard).
- Create new: Søg, Mail-detalje (replaces InboxDetailScreen), Begivenhed, Faktum, Svar-udkast.
- Add `NavBar` primitive for detail screens.

**Phase 4 — Tweaks panel + 7 alt directions**
- `Tweaks` dev panel gated on `__DEV__`.
- Verify rendering for directions A-F-H (skip E QA per scope).
- Adjust any direction-sensitive primitives that broke.

**Phase 5 — Polish + cleanup + QA**
- Device-width sweep (SE/14/14PM/15Pro).
- BlurView Android perf check + opt-out fallback if scroll perf tanks.
- Optional cleanup: delete old `LiquidTabBar`, `ClassicTabBar`, `LiquidTabSwitcher`, `LiquidToggle`, old `Stone.tsx` if confirmed unused.
- Merge to `main` and OTA per `project_build_from_main` memory.

---

## Notes on existing-code interactions

- `src/theme.ts` (old `colors`/`fonts`) stays untouched. Old screens still depend on it.
- `src/components/Stone.tsx` (old) stays untouched. New screens import from `src/design/primitives/Stone.tsx`.
- `src/components/PhoneChrome.tsx` provides chrome insets — keep using it.
- `src/lib/*` (data layer, briefs, reminders, OAuth) — completely off-limits this phase.
- `src/components/IntroVideo.tsx` and splash flow — completely off-limits.
- Notification/widget bridges — completely off-limits.
