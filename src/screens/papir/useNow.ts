import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useTabVisible } from '../../lib/tab-visibility';

/** A clock that actually ticks (H7). Papir's tab screens are keep-alive
 * mounted (never unmount on tab switch), so a bare `new Date()` per render
 * freezes at first paint — greetings, "I dag" grouping and due-filters go
 * stale past midnight or after hours in the background. Ticks every
 * `intervalMs` and immediately on foreground. The interval only runs while
 * the surrounding tab pane is visible (battery); returning to the pane
 * fires a fresh tick, so nothing renders stale. */
export function useNow(intervalMs = 60_000): Date {
  const visible = useTabVisible();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!visible) return;
    // Catch up immediately — this pane may have been hidden for hours.
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), intervalMs);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(new Date());
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [intervalMs, visible]);
  return now;
}
