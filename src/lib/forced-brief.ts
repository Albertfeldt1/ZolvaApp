// "First win": fire one on-demand brief generation per user, right after the
// onboarding connect step, so a real brief is waiting on Today instead of an
// empty screen until the next cron window. Fire-and-forget — failures are
// warn-only and never block onboarding.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const forcedBriefKey = (uid: string) => `zolva.${uid}.forced-brief.requested`;

type Listener = () => void;
const listeners = new Set<Listener>();

// TodayScreen subscribes so it can refresh useTodayBrief the moment the
// forced generation settles (success or not — a refresh is harmless).
export function onForcedBriefSettled(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function requestForcedBriefOnce(uid: string): Promise<void> {
  try {
    if ((await AsyncStorage.getItem(forcedBriefKey(uid))) === '1') return;
    await AsyncStorage.setItem(forcedBriefKey(uid), '1');
  } catch {
    // storage failure → proceed; worst case the server dedupes via already-briefed
  }
  try {
    await supabase.functions.invoke('daily-brief', { body: { force: true } });
  } catch (err) {
    if (__DEV__) console.warn('[forced-brief] request failed:', err);
  } finally {
    listeners.forEach((fn) => fn());
  }
}
