import { createContext, useContext } from 'react';
import type { MailProvider } from '../../lib/types';
import type { PapirTab } from './PapirBottomNav';

export type PushScreen = 'briefing' | 'chat' | 'search' | 'settings' | 'inbox' | 'mailDetail' | 'agent' | 'notifications' | 'signature' | 'noteDetail' | 'sentMails';

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
  /** slide: animate the tab pane in from the right — use when navigating
   * from CONTENT (shortcuts, "Se alle" links) so it matches the push
   * transition; plain bottom-nav switches stay instant. */
  setTab: (t: PapirTab, opts?: { slide?: boolean }) => void;
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

// ---------------------------------------------------------------------------
// Routing-bro for kald UDEN FOR shellen (App.tsx: notifikationstryk og
// zolva://-deep links). Bufferet med "seneste vinder": et tryk ved koldstart
// kan fyre før PapirShell er mounted — shellen forbruger den ventende rute
// ved mount og lytter derefter live.

export type PapirRouteRequest =
  | { kind: 'tab'; tab: PapirTab }
  | { kind: 'push'; screen: PushScreen; params?: PushParams };

let pendingRoute: PapirRouteRequest | null = null;
const routeListeners = new Set<() => void>();

export function requestPapirRoute(req: PapirRouteRequest): void {
  pendingRoute = req;
  routeListeners.forEach((l) => l());
}

/** Shell-side: hent og ryd den ventende rute (null hvis ingen). */
export function consumePapirRoute(): PapirRouteRequest | null {
  const r = pendingRoute;
  pendingRoute = null;
  return r;
}

export function subscribePapirRoute(listener: () => void): () => void {
  routeListeners.add(listener);
  return () => routeListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Bro for stemme-spørgsmål: optage-flowet (den store knap i bundnavigationen)
// ruter et transskriberet spørgsmål til chatten via push('chat') og lægger
// teksten her — PapirChat forbruger den ved mount og lytter derefter live.
// Samme "seneste vinder"-buffer som ruterne: push kan fyre før chatten er
// mounted. Chatten sender teksten som en normal tur; svaret læses kun op
// hvis brugeren selv trykker på højttaleren på boblen.

let pendingVoiceQuestion: string | null = null;
const voiceQuestionListeners = new Set<() => void>();

export function requestChatVoiceQuestion(text: string): void {
  pendingVoiceQuestion = text;
  voiceQuestionListeners.forEach((l) => l());
}

/** Chat-side: hent og ryd det ventende spørgsmål (null hvis ingen). */
export function consumeChatVoiceQuestion(): string | null {
  const q = pendingVoiceQuestion;
  pendingVoiceQuestion = null;
  return q;
}

export function subscribeChatVoiceQuestion(listener: () => void): () => void {
  voiceQuestionListeners.add(listener);
  return () => voiceQuestionListeners.delete(listener);
}
