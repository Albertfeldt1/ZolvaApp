import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** A clock that actually ticks (H7). Papir's tab screens are keep-alive
 * mounted (never unmount on tab switch), so a bare `new Date()` per render
 * freezes at first paint — greetings, "I dag" grouping and due-filters go
 * stale past midnight or after hours in the background. Ticks every
 * `intervalMs` and immediately on foreground. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(new Date());
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [intervalMs]);
  return now;
}
