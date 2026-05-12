import { AppState, AppStateStatus } from 'react-native';
import { supabase } from './supabase';

export type PresenceEvent = 'foreground' | 'background';

export interface PresencePayload {
  user_id: string;
  last_active_at: string;
  last_app_open_at?: string;
}

export function buildPresencePayload(
  event: PresenceEvent,
  userId: string,
  now: Date = new Date(),
): PresencePayload {
  const iso = now.toISOString();
  if (event === 'foreground') {
    return { user_id: userId, last_active_at: iso, last_app_open_at: iso };
  }
  return { user_id: userId, last_active_at: iso };
}

export async function pingPresence(event: PresenceEvent, userId: string): Promise<void> {
  const payload = buildPresencePayload(event, userId);
  const { error } = await supabase
    .from('user_presence')
    .upsert(payload, { onConflict: 'user_id' });
  if (error) console.warn('[presence] upsert failed:', error.message);
}

let subscription: { remove: () => void } | null = null;

export function registerPresenceListener(getUserId: () => string | null): () => void {
  const handler = (state: AppStateStatus) => {
    const uid = getUserId();
    if (!uid) return;
    if (state === 'active') pingPresence('foreground', uid).catch(() => {});
    else if (state === 'background' || state === 'inactive') pingPresence('background', uid).catch(() => {});
  };
  const initial = getUserId();
  if (initial) pingPresence('foreground', initial).catch(() => {});
  subscription = AppState.addEventListener('change', handler);
  return () => {
    subscription?.remove();
    subscription = null;
  };
}
