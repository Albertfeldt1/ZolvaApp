// Client-side Expo push token lifecycle. Fetches a push token from Expo's
// servers and mirrors it into Supabase so the backend can address this
// device. Called from the "Nye mails" Settings toggle.

import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { supabase } from './supabase';

function getProjectId(): string | undefined {
  const fromConfig = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromConfig === 'string' && fromConfig.length > 0) return fromConfig;
  const fromEasConfig = (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
  if (typeof fromEasConfig === 'string' && fromEasConfig.length > 0) return fromEasConfig;
  return undefined;
}

export type RegisterResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'no-session' | 'no-token' | 'persist-failed' };

export async function registerPushToken(): Promise<RegisterResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) return { ok: false, reason: 'no-session' };

  // iOS simulator cannot obtain a push token and expo-notifications emits a
  // yellow-box warning on every call. Short-circuit here so dev-on-sim is
  // quiet — real devices keep working.
  if (!Device.isDevice) return { ok: false, reason: 'no-token' };

  let tokenValue: string;
  try {
    const projectId = getProjectId();
    const res = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    tokenValue = res.data;
  } catch (err) {
    if (__DEV__) console.warn('[push] getExpoPushTokenAsync failed:', err);
    return { ok: false, reason: 'no-token' };
  }
  if (!tokenValue) return { ok: false, reason: 'no-token' };

  const row = {
    user_id: userId,
    token: tokenValue,
    platform: Platform.OS,
    last_seen_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('push_tokens')
    .upsert(row, { onConflict: 'user_id,token' });
  if (error) {
    if (__DEV__) console.warn('[push] upsert push_tokens failed:', error.message);
    return { ok: false, reason: 'persist-failed' };
  }
  return { ok: true, token: tokenValue };
}

export async function unregisterPushToken(): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) return;

  let tokenValue: string | null = null;
  if (Device.isDevice) {
    try {
      const projectId = getProjectId();
      const res = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      );
      tokenValue = res.data;
    } catch (err) {
      if (__DEV__) console.warn('[push] getExpoPushTokenAsync during unregister failed:', err);
    }
  }

  const query = supabase.from('push_tokens').delete().eq('user_id', userId);
  const scoped = tokenValue ? query.eq('token', tokenValue) : query;
  const { error } = await scoped;
  if (error && __DEV__) {
    console.warn('[push] delete push_tokens failed:', error.message);
  }
}

// Flip `enabled` on every mail_watcher row belonging to the user so the
// server-side poller respects the newMail toggle. No-op if the user has
// no connected mail accounts yet — the watcher rows only exist after
// Google/Microsoft are linked (bootstrapped in auth.ts).
export async function setMailWatchersEnabled(enabled: boolean): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) return;
  const { error } = await supabase
    .from('mail_watchers')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error && __DEV__) {
    console.warn('[push] update mail_watchers.enabled failed:', error.message);
  }
}
