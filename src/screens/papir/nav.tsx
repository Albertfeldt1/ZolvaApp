import { createContext, useContext } from 'react';

export type PushScreen = 'briefing' | 'chat' | 'search' | 'settings' | 'inbox';

type Nav = {
  push: (s: PushScreen) => void;
  back: () => void;
};

const NavCtx = createContext<Nav>({ push: () => {}, back: () => {} });

export const usePapirNav = () => useContext(NavCtx);
export const PapirNavProvider = NavCtx.Provider;
