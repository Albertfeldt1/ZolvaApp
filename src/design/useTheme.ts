import { useContext, useMemo } from 'react';
import { ThemeContext } from './ThemeProvider';
import {
  blur,
  fontFamilies,
  getSurfaces,
  heroStat,
  radius,
  shadows,
  spacing,
  stoneTokens,
  typeScale,
} from './theme';

export function useTheme() {
  const { tokens, direction, setDirection } = useContext(ThemeContext);
  const surface = useMemo(() => getSurfaces(tokens), [tokens]);
  return {
    t: tokens,
    direction,
    setDirection,
    spacing,
    radius,
    type: typeScale,
    fonts: fontFamilies,
    stone: stoneTokens,
    surface,
    shadows,
    blur,
    heroStat,
  };
}
