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
      if (v && v in directions) setDirectionState(v as DirectionId);
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
