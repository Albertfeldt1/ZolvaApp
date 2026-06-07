# Zolva Design System

> Living reference for the app's visual language. The **source of truth is the code**
> under `src/design/` — this doc consolidates it so you don't have to read six files to
> answer "what's the body text color?" If the two ever disagree, the code wins; update
> this doc.

The design language is **"Glass & Air" (Direction G)**: a warm bone-white paper, coral
accent, frosted-glass cards floating over soft color halos, Space Grotesk type, and the
green **Stone** mascot. It landed in the 2026-05 visual revamp
(`docs/superpowers/plans/2026-05-05-visual-revamp-phase1-foundation.md`).

---

## 1. Where it lives

```
src/design/
  theme.ts            ← all tokens: directions, type scale, spacing, radius,
                        shadows, blur, surfaces, stone/hero tokens
  ThemeProvider.tsx   ← React context; holds active direction, persists to AsyncStorage
  useTheme.ts         ← the hook every consumer uses
  fonts.ts            ← useDesignFonts() loads Space Grotesk weights
  motion/
    useStoneJump.ts   ← Reanimated hop animation for the Stone
  primitives/
    Stone.tsx         ← re-exports the canonical Stone from src/components/Stone.tsx
    Icon.tsx          ← stroke-based SVG icon set
    GlassFrostedCard.tsx
    GlassHaloLayer.tsx
    GlassTabBar.tsx
    TopBar.tsx
```

There is also a **legacy `src/theme.ts`** still in use — see §7 (Migration status).

---

## 2. How to consume it

Everything flows through one hook:

```tsx
import { useTheme } from '@/design/useTheme';

function MyCard() {
  const { t, type, spacing, radius, surface, shadows, blur, stone, heroStat } = useTheme();
  return (
    <View style={{
      backgroundColor: surface.glass,
      borderRadius: radius.card,
      padding: spacing.cardPad,
      ...shadows.softCard,
    }}>
      <Text style={{ ...type.title, color: t.ink }}>Hej</Text>
    </View>
  );
}
```

The hook returns:

| Key        | What it is                                                        |
|------------|------------------------------------------------------------------|
| `t`        | active `DirectionTokens` (colors + radii for the current direction) |
| `direction` / `setDirection` | current direction id + setter (persists)           |
| `type`     | `typeScale` — text presets                                        |
| `fonts`    | `fontFamilies` — raw font-family strings                          |
| `spacing`  | spacing scale + semantic pads                                    |
| `radius`   | corner-radius scale                                              |
| `surface`  | direction-aware surface overlays (glass, fab, tabBar, success…) |
| `shadows`  | shadow presets (spread onto a View's style)                     |
| `blur`     | `BlurView` intensities                                           |
| `stone`    | Stone mascot palette                                             |
| `heroStat` | hero stat-card sizing constants                                  |

> **Don't hard-code hex/sizes in screens.** Pull from `useTheme()` so the direction
> system and dark mode keep working. Use `surface.*` for translucent surfaces (not
> `t.paper` with manual opacity).

---

## 3. Color tokens

### Direction G (active) — "Glass & Air"

| Token       | Value       | Use                                           |
|-------------|-------------|-----------------------------------------------|
| `t.paper`   | `#FBFBFA`   | screen background ("bone")                     |
| `t.ink`     | `#0F1014`   | primary text                                   |
| `t.ink2`    | `#3A3D43`   | secondary text / icon glyphs                   |
| `t.ink3`    | `#7A7D84`   | tertiary text, inactive tab icons             |
| `t.ink4`    | `#B5B7BB`   | faint / disabled                              |
| `t.line`    | `rgba(15,16,20,0.08)` | hairline borders                    |
| `t.today`   | `#FF7A4D`   | Today section accent (coral)                   |
| `t.inbox`   | `#FF7A4D`   | Inbox accent (same coral in G)                 |
| `t.cal`     | `#FF9D6E`   | Calendar accent (warm)                         |
| `t.mem`     | `#B07AE0`   | Memory accent (violet)                         |
| `t.radius`  | `24`        | card radius                                    |
| `t.radiusSm`| `18`        | small radius                                   |

The four **section accents** (`today` / `inbox` / `cal` / `mem`) are the app's color-coding
spine — each tab and its halos use its accent. In Direction G the palette is deliberately
warm/monochromatic (coral-forward) rather than four distinct hues.

### Success / state
Direction G has no green signal hue, so success ("connected", "done") is encoded in the
surface tokens, not derived from an accent:
- `surface.successText` `#15803D` (light) / `#86EFAC` (dark)
- `surface.successTint` `rgba(34,197,94,0.16)` (light)

### Surfaces (direction-aware, `useTheme().surface`)
The frosted look = a `BlurView` with one of these translucent overlays on top.

| Token                     | Light value              | Use                                  |
|---------------------------|--------------------------|--------------------------------------|
| `glass`                   | `rgba(255,255,255,0.65)` | standard frosted card overlay        |
| `glassStrong`             | `rgba(255,255,255,0.55)` | over busier/halo-heavy areas         |
| `glassWeak`               | `rgba(255,255,255,0.7)`  | subtle frost                         |
| `glassRim`                | `rgba(255,255,255,0.8)`  | 1px top rim on glass cards           |
| `glassAndroidFallback`    | `rgba(255,255,255,0.85)` | near-opaque where blur is weak       |
| `bone`                    | `rgba(252,251,248,0.95)` | near-opaque hero/section backdrops   |
| `scrim`                   | `rgba(15,16,20,0.05)`    | press/hover scrim                    |
| `fab` / `fabText`         | `rgba(21,23,26,0.78)` / `#FFFFFF` | the "Spørg Zolva" FAB     |
| `iconButton`              | `rgba(21,23,26,0.05)`    | round icon-button background         |
| `tabBar` / `tabActive`    | `rgba(255,255,255,0.55)` / `rgba(255,255,255,0.9)` | tab pill |
| `warningTint`             | `rgba(255,193,127,0.55)` | warning highlight                    |
| `ribbonTrack`             | `rgba(15,16,20,0.05)`    | progress ribbon track                |

Every surface token has a **dark variant** (`SURFACES_DARK`) selected automatically via
`getSurfaces(t)` when `t.mode === 'dark'` (only Direction E today).

---

## 4. Typography

**One typeface everywhere: Space Grotesk** (loaded by `useDesignFonts()`). The "mono"
aliases are still Space Grotesk — only the weight differs, so existing call sites don't
need to change.

| Alias (`fonts.*`) | Family                       |
|-------------------|------------------------------|
| `display`         | `SpaceGrotesk_500Medium`     |
| `displayBold`     | `SpaceGrotesk_700Bold`       |
| `ui` / `uiRegular`| `SpaceGrotesk_500Medium`     |
| `uiBold`          | `SpaceGrotesk_600SemiBold`   |
| `mono`            | `SpaceGrotesk_500Medium`     |
| `monoBold`        | `SpaceGrotesk_600SemiBold`   |

### Type scale (`useTheme().type`)

| Preset      | Size / line / tracking | Typical use                       |
|-------------|------------------------|-----------------------------------|
| `displayXL` | 44 / 46 / -2           | screen hero numbers/titles        |
| `displayL`  | 34 / 36 / -1.4         | large headings                    |
| `displayM`  | 30 / 34 / -1.2         | section headers                   |
| `displayS`  | 24 / 28 / -0.8         | sub-headers                       |
| `title`     | 18 / 22 / -0.3         | card titles                       |
| `body`      | 14 / 20 / 0            | body text                         |
| `bodySm`    | 13 / 18 / 0            | dense body                        |
| `caption`   | 11.5 / 16 / 0          | captions / meta                   |
| `eyebrow`   | 10.5 / 14 / 1.2, UPPERCASE | section eyebrows, dates       |

Apply as `style={{ ...type.title, color: t.ink }}` — presets carry size/line/tracking/font
but **not color**; always pair with an `ink` token.

---

## 5. Spacing, radius, elevation, blur

### Spacing (`useTheme().spacing`)
Scale: `xs 4 · sm 8 · md 12 · lg 18 · xl 24 · xxl 32`
Semantic: `screenPad 18 · cardPad 14 · heroPad 22 · statusBarFallback 56 · tabBarLift 18 · tabBarSideMargin 48 · fabSideMargin 48`

### Radius (`useTheme().radius`)
`sharp 6 · soft 18 · pill 9999 · card 24 · cardSm 14`

### Shadows (`useTheme().shadows`) — spread onto a View's `style`
`softCard` (resting cards) · `elevated` (modals/sheets) · `fab` · `tabBar` · `stoneCast`
(green-tinted shadow under the Stone).

### Blur (`useTheme().blur`) — `BlurView` `intensity`
`card 45 · hero 50 · glassStrong 70 · haloField 80 · tabBarIos 70 · tabBarAndroid 60 · pill 14`
Android uses lower values because the native blur is weaker — prefer these tokens over
literals so the platform split stays consistent.

---

## 6. Primitives

Import from `src/design/primitives/*`. All read `useTheme()` internally.

### `<Stone>` — the mascot
Canonical impl: `src/components/Stone.tsx` (the design primitive re-exports it). Green
pebble with blinking eyes, gaze tracking, and a tap-hop.
```tsx
<Stone mood="calm" size={44} jumpOnTap onPress={...} />
```
- `mood?: 'calm' | 'thinking' | 'happy'` (default `calm`)
- `size?: number` (default `44`); the mouth only renders at `size >= 30`
- `jumpOnTap?: boolean` (default `true`), `onPress?`
- Palette in `useTheme().stone` (`body #6B8770`, `edge`, `glow`, `rim`, `face`, `shadowCast`).

### `Icon` — stroke SVG set
```tsx
<Icon.mail size={18} color={t.ink2} />
```
Names: `sun · mail · cal · bookmark · bell · gear · chev · plus · send · mic · audio ·
arrowUp · sparkle · search · archive`. Stroke-based (width 1.6), `color` required,
`size` default 18.

### `<GlassFrostedCard>` — the standard card
`BlurView` + translucent overlay + 1px white rim. Props: `children`, `intensity?`,
`radius?`, `overlay?` (defaults pull from `blur.card`, `radius.card`, `surface.glass`).

### `<GlassHaloLayer>` — background depth
Absolutely-positioned oversized soft color halos fused by a heavy `BlurView`. Renders
behind glass content to give the "air" look. No props.

### `<GlassTabBar>` — bottom navigation
4-tab frosted pill + the "Spørg Zolva" FAB (which is a non-tappable-jump Stone).
```tsx
<GlassTabBar active={tab} onChange={setTab} onAskZolva={openChat} bottomInset={insets.bottom} />
```
`TabId = 'today' | 'inbox' | 'cal' | 'mem'`. Active icon uses the tab's section accent;
inactive uses `t.ink3`.

### `<TopBar>` — screen header
Eyebrow (date/label) + optional action buttons.
```tsx
<TopBar eyebrow="MANDAG 7. JUNI" onBell={...} onGear={...} onSend={...} onArchive={...} />
```

---

## 7. Directions & theming

`theme.ts` ships **8 directions (A–H)** — alternate color/radius/mode token sets. Only
**G is active**; the rest exist as data for a future in-app theme switcher.

| id | name             | mode  | note                                  |
|----|------------------|-------|---------------------------------------|
| A  | Vibrant Fills    | light |                                       |
| B  | Soft Saturation  | light |                                       |
| C  | Bold Contrast    | light |                                       |
| D  | Neutral + Pop    | light |                                       |
| E  | Twilight         | **dark** | the only dark direction (`SURFACES_DARK`) |
| F  | Editorial Mono   | light | Playfair Display italic display override |
| **G** | **Glass & Air** | light | **active default**                  |
| H  | Card Stack       | light |                                       |

`ThemeProvider` holds the active direction, defaults to `G`, and persists user choice to
`AsyncStorage` under `@zolva/design-direction`. Switch at runtime with
`useTheme().setDirection('E')`. Because surfaces are derived via `getSurfaces(t)`, building
new UI purely from tokens means dark mode (E) and every other direction work for free.

---

## 8. Migration status (new vs legacy)

Two systems coexist. The **2026-05 revamp** introduced `src/design/`; the older
`src/theme.ts` was intentionally left live and is being migrated screen-by-screen. Many
files currently import from **both** while mid-migration.

**Fully on the new system (`src/design` only):**
`MemoryScreen`, `ChatScreen`, `CalendarScreen`, `InboxDetailScreen`, `NotificationsScreen`,
`SentMailScreen`, `IcloudSetupScreen`, `DeleteAccountScreen`, `MicrosoftAdminConsentScreen`,
the Onboarding\* screens, and most modal components.

**Still touching legacy `src/theme.ts`:**
- Screens on **both**: `TodayScreen`, `InboxScreen`, `SettingsScreen` (partially migrated).
- Components on legacy: `BriefBanner`, `ClassicTabBar`, `LiquidTabBar`, `LiquidTabSwitcher`,
  `LiquidToggle`, `EmptyState`, `ErrorBoundary`, `FactRow`, `OfflineBanner`, `Pill`,
  `Skeleton`, `TopRightActions`, `AgentActionPolicySection`, `TodayAgentFeed`,
  `TrustPromotionsSection`, `ZolvaHandlingerSection`, and others.

**Rule going forward:** new UI uses `src/design/` exclusively. When you touch a
legacy-importing file, migrate its theme usage if it's low-risk; otherwise leave a note.
The end state is `src/theme.ts` deleted.

---

## 9. Gotchas worth knowing

- **Hero digits clip** if `lineHeight < fontSize` in Space Grotesk at large sizes — that's
  why `heroStat.bigLineHeight (72) > bigSize (64)`. Keep line-height ≥ size for big display text.
- **Android blur is weaker** — always use the `blur.*` tokens (they encode the iOS/Android
  split) and lean on `glassAndroidFallback` where a readable surface matters.
- **Translucency over halos**: use `glassStrong` (more opaque) over busy/halo areas so text
  stays legible; `glass` elsewhere.
- **Success is a surface token, not an accent** — use `surface.successText/Tint`, don't
  invent a green.
- **Color belongs on the consumer**, type presets don't carry it — always pair `...type.x`
  with a `t.ink*` color.
- The **handoff source assets** referenced by the revamp plan (`tokens.json`, the `.jsx`
  prototypes, `RN_GOTCHAS.md`, Stone SVGs) live outside the repo in `~/Downloads/handoff/`,
  not under version control.
</content>
</invoke>
