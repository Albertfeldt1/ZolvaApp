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
