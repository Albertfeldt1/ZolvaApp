// Single source of truth for the Zolva mascot is the OG SVG-driven Stone
// in src/components/Stone.tsx (blinking eyes, gaze tracking, moods, hop
// animation on press). This file used to host a separate static-SVG
// version; keeping it as a re-export so the many call sites that import
// from `../design/primitives/Stone` continue to compile while everyone
// gets the OG behavior.
export { Stone } from '../../components/Stone';
export type { StoneMood } from '../../components/Stone';
