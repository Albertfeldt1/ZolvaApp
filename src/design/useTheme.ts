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
