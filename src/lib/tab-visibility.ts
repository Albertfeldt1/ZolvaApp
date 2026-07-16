import { createContext, useContext } from 'react';

/** Whether the nearest keep-alive tab pane is the active (visible) one.
 * PapirShell keeps tab panes mounted with `display: none` after first visit,
 * so periodic UI timers (useNow, feed/notification ticks, the timeline
 * now-line) would otherwise keep firing on panes nobody can see. Timers
 * subscribe here to pause on hidden panes and fire a fresh tick on return,
 * so nothing renders stale. Defaults to true: screens outside the shell
 * (push stack, overlays, classic UI) are unaffected. */
const TabVisibilityContext = createContext(true);

export const TabVisibilityProvider = TabVisibilityContext.Provider;

export function useTabVisible(): boolean {
  return useContext(TabVisibilityContext);
}
