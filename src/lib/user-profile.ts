import { supabase } from './supabase';

// Upsert the device's resolved IANA timezone into public.user_profiles.
// Fire-and-forget; a failure just means the daily-brief edge function
// falls back to UTC for this user on the next tick.
export function syncUserProfile(userId: string): void {
  let timezone: string;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    timezone = 'UTC';
  }
  void supabase
    .from('user_profiles')
    .upsert(
      { user_id: userId, timezone, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
    .then(({ error }) => {
      if (error && __DEV__) {
        console.warn('[user-profile] upsert failed:', error.message);
      }
    });
}

// Mirror the local `memory-enabled` privacy toggle to user_profiles so cron
// edge functions (daily-brief, fact-decay-warning) and chat-run can
// short-circuit when the user has memory turned off, AND so other
// devices belonging to the same account read the same gate (see
// fetchServerMemoryEnabled below — without that read path, phone B would
// silently keep showing memory off while phone A's toggle made the
// server treat the account as opted-in).
//
// Throws on Supabase error so the caller can revert local state. Callers
// MUST handle this — leaving local AsyncStorage diverged from the server
// is the canonical privacy-bug shape.
export async function syncMemoryEnabled(userId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from('user_profiles')
    .upsert(
      { user_id: userId, memory_enabled: enabled, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (error) throw new Error(error.message);
}

// Read `user_profiles.memory_enabled` for the given user. Returns the
// boolean if the row exists, `null` if the row is missing or the read
// fails (network, RLS, db). Callers treat `null` as "no authoritative
// value available" and should fall back to the AsyncStorage cache —
// NOT to a hard `false` default — so a user with `true` in cache and no
// network keeps memory on, instead of being silently opted out.
export async function fetchServerMemoryEnabled(userId: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('memory_enabled')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      if (__DEV__) console.warn('[user-profile] memory_enabled read failed:', error.message);
      return null;
    }
    if (!data || typeof data.memory_enabled !== 'boolean') return null;
    return data.memory_enabled;
  } catch (err) {
    if (__DEV__) console.warn('[user-profile] memory_enabled read threw:', err);
    return null;
  }
}
