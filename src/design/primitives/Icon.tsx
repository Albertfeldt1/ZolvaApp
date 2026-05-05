import React from 'react';
import { Circle, Path, Rect, Svg } from 'react-native-svg';

type IconProps = { size?: number; color: string };

const make = (paths: React.ReactNode) =>
  ({ size = 18, color }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      {paths}
    </Svg>
  );

export const Icon = {
  sun: make(
    <>
      <Circle cx={12} cy={12} r={4} />
      <Path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>,
  ),
  mail: make(
    <>
      <Rect x={3} y={5} width={18} height={14} rx={2} />
      <Path d="M3 7l9 6 9-6" />
    </>,
  ),
  cal: make(
    <>
      <Rect x={3} y={5} width={18} height={16} rx={2} />
      <Path d="M3 9h18M8 3v4M16 3v4" />
    </>,
  ),
  bookmark: make(<Path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />),
  bell: make(
    <>
      <Path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9" />
      <Path d="M13.73 21a2 2 0 01-3.46 0" />
    </>,
  ),
  gear: make(
    <>
      <Circle cx={12} cy={12} r={3} />
      <Path d="M19.4 15a1.7 1.7 0 00.34 1.86l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.86-.34 1.7 1.7 0 00-1.04 1.55V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008.6 19.4a1.7 1.7 0 00-1.86.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.55-1.04H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 9 1.7 1.7 0 004.26 7.14l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6 1.7 1.7 0 0010.04 3.05V3a2 2 0 114 0v.1A1.7 1.7 0 0015.4 4.6a1.7 1.7 0 001.86-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9c0 .69.4 1.32 1.04 1.55H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1.04z" />
    </>,
  ),
  chev: make(<Path d="M9 6l6 6-6 6" />),
  plus: make(<Path d="M12 5v14M5 12h14" />),
  send: make(<Path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />),
  sparkle: make(<Path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />),
  search: make(
    <>
      <Circle cx={11} cy={11} r={7} />
      <Path d="M21 21l-4.3-4.3" />
    </>,
  ),
} as const;
