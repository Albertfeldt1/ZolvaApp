import { createContext, useContext } from 'react';
import type { MailProvider } from '../../lib/types';
import type { PapirTab } from './PapirBottomNav';

export type PushScreen = 'briefing' | 'chat' | 'search' | 'settings' | 'inbox' | 'mailDetail';

/** Per-push params — mailDetail carries the list-row context so the detail
 * screen can render header + AI draft instantly while the body fetches. */
export type PushParams = {
  id?: string;
  provider?: MailProvider;
  from?: string;
  subject?: string;
  time?: string;
  aiDraft?: string | null;
};

export type PushEntry = { key: string; screen: PushScreen; params?: PushParams };

type Nav = {
  push: (s: PushScreen, params?: PushParams) => void;
  back: () => void;
  setTab: (t: PapirTab) => void;
  /** Opens the shared AuthSheet overlay (wired in PapirRoot). */
  openAuth: () => void;
  /** Screens with unsaved state (e.g. a mail draft) register a guard the
   * shell consults before hardware-back pops the stack. Return true to
   * consume the event (the guard shows its own confirm). Unregister with
   * null on unmount (H6). */
  setBackGuard: (guard: (() => boolean) | null) => void;
};

const NavCtx = createContext<Nav>({
  push: () => {},
  back: () => {},
  setTab: () => {},
  openAuth: () => {},
  setBackGuard: () => {},
});

export const usePapirNav = () => useContext(NavCtx);
export const PapirNavProvider = NavCtx.Provider;
