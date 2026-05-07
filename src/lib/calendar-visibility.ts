// AsyncStorage-backed map of hidden calendars per provider. Default model:
// any calendar not in the hidden set is visible - matches Apple Calendar
// where new accounts/calendars come on by default. Storage is local-only
// for v1 (no Supabase sync); switching devices means re-toggling.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

export type CalendarVisibility = {
  // Provider → array of calendar IDs that are HIDDEN (everything else visible).
  // Storing the hidden set rather than the visible set means newly-discovered
  // calendars default-on without needing a write at discovery time.
  google?: string[];
  microsoft?: string[];
  icloud?: string[];
};

type Provider = 'google' | 'microsoft' | 'icloud';

const storageKey = (uid: string) => `zolva.${uid}.calendar-visibility`;

async function load(uid: string): Promise<CalendarVisibility> {
  if (!uid) return {};
  const raw = await AsyncStorage.getItem(storageKey(uid));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as CalendarVisibility;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function save(uid: string, v: CalendarVisibility): Promise<void> {
  if (!uid) return;
  await AsyncStorage.setItem(storageKey(uid), JSON.stringify(v));
}

export function isCalendarVisible(
  visibility: CalendarVisibility,
  provider: Provider,
  calendarId: string,
): boolean {
  const hidden = visibility[provider] ?? [];
  return !hidden.includes(calendarId);
}

// Module-level signal so all consumers (the calendar screen and the picker
// itself) refetch in lockstep when a switch flips. Mirrors the mailRefresh
// pattern in hooks.ts.
const subscribers = new Set<(v: CalendarVisibility) => void>();

export function useCalendarVisibility(userId: string) {
  const [visibility, setVisibility] = useState<CalendarVisibility>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    void load(userId).then((v) => {
      if (cancelled) return;
      setVisibility(v);
      setHydrated(true);
    });
    const onChange = (v: CalendarVisibility) => { if (!cancelled) setVisibility(v); };
    subscribers.add(onChange);
    return () => { cancelled = true; subscribers.delete(onChange); };
  }, [userId]);

  const setHidden = useCallback(
    async (provider: Provider, calendarId: string, hidden: boolean) => {
      const current = await load(userId);
      const list = new Set(current[provider] ?? []);
      if (hidden) list.add(calendarId);
      else list.delete(calendarId);
      const next: CalendarVisibility = { ...current, [provider]: Array.from(list) };
      await save(userId, next);
      subscribers.forEach((fn) => fn(next));
    },
    [userId],
  );

  return { visibility, hydrated, setHidden };
}
