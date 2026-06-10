// src/lib/trial-nudges.ts
//
// Trial conversion nudges (billing #4). Pure decision logic at the top so
// it's unit-testable; AsyncStorage + expo-notifications wrappers below are
// deliberately thin.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { PAYWALL_RESULT } from 'react-native-purchases-ui';
import type { Entitlement, Tier } from './entitlement';
import type { NotificationPayload } from './types';
import { presentPaywall } from './paywall';

export type PitchRecord = { at: string; outcome: 'started' | 'skipped' } | null;

const DAY_MS = 86400_000;
const SKIPPER_MIN_AGE_MS = 3 * DAY_MS;
const TRIAL_BANNER_WINDOW_MS = 2 * DAY_MS;

// --- pure decision logic ---------------------------------------------------

export function skipperNudgeEligible(args: {
  tier: Tier;
  pitch: PitchRecord;
  dismissed: boolean;
  now: Date;
}): boolean {
  if (args.tier !== 'free' || args.dismissed) return false;
  if (!args.pitch || args.pitch.outcome !== 'skipped') return false;
  const age = args.now.getTime() - new Date(args.pitch.at).getTime();
  return age >= SKIPPER_MIN_AGE_MS;
}

export function trialEndingBannerVisible(ent: Entitlement, now: Date): boolean {
  if (!ent.isTrial || !ent.trialEndsAt) return false;
  const remaining = new Date(ent.trialEndsAt).getTime() - now.getTime();
  return remaining > 0 && remaining <= TRIAL_BANNER_WINDOW_MS;
}

// T−2 days, or null when that moment has passed / user isn't on trial.
export function trialEndingFireDate(ent: Entitlement, now: Date): Date | null {
  if (!ent.isTrial || !ent.trialEndsAt) return null;
  const fireAt = new Date(new Date(ent.trialEndsAt).getTime() - TRIAL_BANNER_WINDOW_MS);
  return fireAt.getTime() > now.getTime() ? fireAt : null;
}

// --- pitch outcome storage ---------------------------------------------------

const pitchKey = (uid: string) => `zolva.${uid}.trial-pitch`;
const skipperDismissKey = (uid: string) => `zolva.${uid}.trial-skipper-nudge.dismissed`;

export async function recordPitchOutcome(uid: string, outcome: 'started' | 'skipped'): Promise<void> {
  try {
    await AsyncStorage.setItem(pitchKey(uid), JSON.stringify({ at: new Date().toISOString(), outcome }));
  } catch {}
}

export async function readPitchRecord(uid: string): Promise<PitchRecord> {
  try {
    const raw = await AsyncStorage.getItem(pitchKey(uid));
    return raw ? (JSON.parse(raw) as PitchRecord) : null;
  } catch {
    return null;
  }
}

export async function markSkipperNudgeDismissed(uid: string): Promise<void> {
  try { await AsyncStorage.setItem(skipperDismissKey(uid), '1'); } catch {}
}

export async function readSkipperNudgeDismissed(uid: string): Promise<boolean> {
  // Fail closed: if storage is unreadable, treat as dismissed so we never
  // nag a user who already said no.
  try { return (await AsyncStorage.getItem(skipperDismissKey(uid))) === '1'; } catch { return true; }
}

// --- onboarding pitch ----------------------------------------------------------

// Present the trial paywall after the onboarding win. Skippable by design;
// records the outcome so the skipper nudge knows whom to chase.
export async function presentTrialPitch(uid: string | null): Promise<'started' | 'skipped'> {
  if (!uid) return 'skipped'; // not signed in (skipped connect) — gates catch them later
  const result = await presentPaywall();
  const started = result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED;
  const outcome = started ? 'started' : 'skipped';
  await recordPitchOutcome(uid, outcome);
  return outcome;
}

// --- trial-ending local notification ---------------------------------------------

const TRIAL_ENDING_NOTIF_ID = 'zolva-trial-ending-2d';

// useEntitlement mounts in several components; identical resolutions would
// otherwise cancel+reschedule on every mount. Cache the last fire time and
// only touch the OS scheduler when it actually changes.
let lastScheduledFireMs: number | null = null;

// Idempotent: cancel-then-(re)schedule under a stable identifier, safe to call
// on every entitlement resolution. Off-trial → cancels any pending reminder.
// Notification content includes data: { type: 'trialEnding' } consistent with
// the NotificationPayload union. dispatchPayload silently ignores unknown types,
// so tap-routing for trialEnding can be wired in a later task without a breaking
// change; the type tag is present now so the union is accurate.
export async function syncTrialEndingNotification(ent: Entitlement): Promise<void> {
  const fireAt = trialEndingFireDate(ent, new Date());
  const fireMs = fireAt?.getTime() ?? null;
  if (fireMs === lastScheduledFireMs) return;
  lastScheduledFireMs = fireMs;
  try {
    await Notifications.cancelScheduledNotificationAsync(TRIAL_ENDING_NOTIF_ID);
  } catch {}
  if (!fireAt) return;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: TRIAL_ENDING_NOTIF_ID,
      content: {
        title: 'Din Pro-prøveperiode slutter snart',
        body: 'Om 2 dage skifter du til gratis-planen, medmindre du fortsætter med Pro.',
        data: { type: 'trialEnding' } satisfies NotificationPayload,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
      },
    });
  } catch (err) {
    lastScheduledFireMs = null;
    if (__DEV__) console.warn('[trial-nudges] schedule failed:', err);
  }
}
