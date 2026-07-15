// In-app feedback (fejl/forslag) fra beta-testere. Indsender til
// `feedback`-tabellen med automatisk metadata — build-nummer, OS og enhed er
// det, der gør en rapport brugbar, og testere oplyser det aldrig selv.

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { getActiveUserId } from './auth';
import { supabase } from './supabase';

export type FeedbackKind = 'bug' | 'idea';

export async function submitFeedback(
  kind: FeedbackKind,
  message: string,
): Promise<{ ok: true } | { ok: false; reason: 'no-session' | 'error' }> {
  const userId = getActiveUserId();
  if (!userId) return { ok: false, reason: 'no-session' };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, reason: 'error' };

  const { error } = await supabase.from('feedback').insert({
    user_id: userId,
    kind,
    message: trimmed.slice(0, 4000),
    app_version: Constants.expoConfig?.version ?? null,
    // Fra den bundlede app.json — matcher det build, brugeren faktisk kører.
    build_number: Constants.expoConfig?.ios?.buildNumber ?? null,
    os: Platform.OS,
    os_version: String(Platform.Version),
    device_model: Device.modelName ?? null,
  });
  if (error) {
    if (__DEV__) console.warn('[feedback] insert failed:', error.message);
    return { ok: false, reason: 'error' };
  }
  return { ok: true };
}
