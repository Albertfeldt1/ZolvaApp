import { createContext, useContext } from 'react';
import type { PapirTab } from './PapirBottomNav';

export type PushScreen = 'briefing' | 'chat' | 'search' | 'settings' | 'inbox' | 'mailDetail';

/** Per-push params. Only mailDetail uses them today (M4). */
export type PushParams = { id?: string; provider?: string };

export type PushEntry = { key: string; screen: PushScreen; params?: PushParams };

type Nav = {
  push: (s: PushScreen, params?: PushParams) => void;
  back: () => void;
  setTab: (t: PapirTab) => void;
  /** Opens the shared AuthSheet overlay (wired in PapirRoot). */
  openAuth: () => void;
};

const NavCtx = createContext<Nav>({
  push: () => {},
  back: () => {},
  setTab: () => {},
  openAuth: () => {},
});

export const usePapirNav = () => useContext(NavCtx);
export const PapirNavProvider = NavCtx.Provider;
