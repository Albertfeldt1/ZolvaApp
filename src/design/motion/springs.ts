// The shared motion vocabulary for the whole app.
//
// Why this file exists: motion that "feels right" is mostly about CONSISTENCY
// — the same press spring, the same enter/exit timing, everywhere. Before this,
// every screen invented its own { damping, stiffness } and hardcoded durations
// (220/260/320/420/540ms scattered around), which reads as subtle unease. Use
// these named presets instead of ad-hoc values so new motion matches the rest.
import { Easing, type WithSpringConfig } from 'react-native-reanimated';

// ─── Spring presets (preferred over fixed durations for the native iOS feel) ──

// Snappy, no overshoot — press feedback (button scales down then back).
export const SPRING_PRESS: WithSpringConfig = { damping: 18, stiffness: 360, mass: 0.7 };

// The canonical "travel" spring already used by the tab/selector pills. Kept
// here so new sliding/selecting elements match the system feel.
export const SPRING_PILL: WithSpringConfig = { damping: 22, stiffness: 260, mass: 1 };

// Gentle settle for reveals, expands and entrance springs — life without bounce.
export const SPRING_GENTLE: WithSpringConfig = { damping: 20, stiffness: 180, mass: 0.9 };

// ─── Duration tokens (ms) for timing-based transitions ────────────────────────
// Convention: an exit is faster than its entrance (~75%), so things leave
// briskly and arrive with a little more grace.
export const DURATION = {
  micro: 120, // instant feedback (toggles, taps)
  enter: 280, // element entering
  exit: 200, // element leaving
  modalEnter: 320,
  modalExit: 240,
} as const;

// ─── Easing curves — confident deceleration. Never linear for UI. ─────────────
export const EASE = {
  out: Easing.bezier(0.22, 1, 0.36, 1), // ease-out-quint, refined
  outExpo: Easing.bezier(0.16, 1, 0.3, 1), // confident, decisive
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
} as const;

// ─── Stagger: one delay step for list/card cascades (was 70ms here, 100ms there) ──
export const STAGGER_MS = 60;
export const staggerDelay = (index: number, base: number = STAGGER_MS): number => index * base;
