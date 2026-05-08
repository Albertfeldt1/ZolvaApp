// Writes the V2 onboarding selections to durable storage (integration flags
// + work_preferences). Without this, the user's choices in the flow look
// stuck only inside the onboarding scope and never appear in Settings -
// which is what they were complaining about.
//
// The helper is non-hook so it can fire from App.tsx's onComplete callback
// without React render plumbing. Failures per row are logged but don't
// block the whole save - one bad upsert shouldn't roll back the others.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { setIntegrationEnabled } from './integration-flags';
import type { IntegrationKey, WorkPreferenceId } from './types';

// Onboarding's "source id" namespace differs from the persistent
// IntegrationKey namespace - bridge them here so callers don't have to.
const SOURCE_TO_INTEGRATION: Record<string, IntegrationKey> = {
  gmail: 'gmail',
  outlook: 'outlook-mail',
  gcal: 'google-calendar',
  ocal: 'outlook-calendar',
  gdrive: 'google-drive',
  onedrive: 'onedrive',
  icloud: 'icloud',
};

// Onboarding persona ids → work_preferences string values. The work-prefs
// table stores the human-readable Danish label (those are also the option
// strings users see in Settings), so the mapping has to be exact - a typo
// here would make the Settings row read "(udfyld)" since the value wouldn't
// match any option.
const AUTONOMY_VALUE: Record<string, string> = {
  ask: 'Spørg altid',
  draft: 'Lav udkast',
  act: 'Handl selv',
};

const TONE_VALUE: Record<string, string> = {
  short: 'Kort',
  warm: 'Venlig',
  formal: 'Formel',
};

const MORNING_BRIEF_VALUE: Record<string, string> = {
  '0700': '07.00',
  '0800': '08.00',
  '0900': '09.00',
};

const workPrefsKey = (uid: string) => `zolva.${uid}.prefs.work`;

export type OnboardingPersistState = {
  persona: { autonomy?: string; tone?: string; morning_brief?: string };
  connections: Partial<Record<string, boolean>>;
};

const PENDING_PERSONA_KEY = 'zolva.onboarding.pending-persona.v1';

// Integration flags (device-level, no uid required). Always safe to write
// at onComplete time even if the OAuth-signed-in user.id hasn't propagated
// to the React layer yet - that's the bug that was eating Gmail/Outlook
// activation: the persist callback gated on user?.id and silently dropped
// the writes when the auth state was mid-broadcast.
export async function persistOnboardingConnections(
  state: OnboardingPersistState,
): Promise<void> {
  const writes: Promise<void>[] = [];
  for (const [sourceId, value] of Object.entries(state.connections ?? {})) {
    const key = SOURCE_TO_INTEGRATION[sourceId];
    if (!key || typeof value !== 'boolean') continue;
    writes.push(
      setIntegrationEnabled(key, value).catch((err) => {
        if (__DEV__) console.warn(`[onboarding-persist] integration ${key} failed:`, err);
      }),
    );
  }
  await Promise.all(writes);
}

// Persona (work_preferences) needs a uid because the table is per-user.
// If we have one, write through. If not, stash the persona in AsyncStorage
// and let App.tsx flush it once user.id appears.
export async function persistOnboardingPersona(
  userId: string | null,
  persona: OnboardingPersistState['persona'],
): Promise<void> {
  const prefRows: Array<{ id: WorkPreferenceId; value: string }> = [];
  if (persona.autonomy) {
    const v = AUTONOMY_VALUE[persona.autonomy];
    if (v) prefRows.push({ id: 'autonomy', value: v });
  }
  if (persona.tone) {
    const v = TONE_VALUE[persona.tone];
    if (v) prefRows.push({ id: 'tone', value: v });
  }
  if (persona.morning_brief) {
    const v = MORNING_BRIEF_VALUE[persona.morning_brief];
    if (v) prefRows.push({ id: 'morning-brief', value: v });
  }
  if (prefRows.length === 0) return;

  if (!userId) {
    // Defer - flushPendingPersona will run when App.tsx sees user.id flip
    // from null to set (typical path: OAuth sign-in mid-onboarding races
    // the auth state propagation with the onComplete callback).
    try {
      await AsyncStorage.setItem(PENDING_PERSONA_KEY, JSON.stringify(persona));
    } catch (err) {
      if (__DEV__) console.warn('[onboarding-persist] pending persona stash failed:', err);
    }
    return;
  }

  const nowIso = new Date().toISOString();
  const upsertRows = prefRows.map((r) => ({
    user_id: userId,
    id: r.id,
    value: r.value,
    updated_at: nowIso,
  }));
  const { error } = await supabase
    .from('work_preferences')
    .upsert(upsertRows, { onConflict: 'user_id,id' });
  if (error && __DEV__) {
    console.warn('[onboarding-persist] work_preferences upsert failed:', error.message);
  }
  // Mirror to AsyncStorage cache. Merge into existing snapshot - other
  // prefs (midday-brief, quiet-hours, evening-brief) may have been seeded
  // already and we don't want to wipe them.
  try {
    const raw = await AsyncStorage.getItem(workPrefsKey(userId));
    const existing: Record<string, string> = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    for (const r of prefRows) existing[r.id] = r.value;
    await AsyncStorage.setItem(workPrefsKey(userId), JSON.stringify(existing));
  } catch (err) {
    if (__DEV__) console.warn('[onboarding-persist] cache write failed:', err);
  }
}

// Flush any persona stashed by persistOnboardingPersona(null, ...). Called
// from App.tsx when user.id transitions from null to set so a fresh OAuth
// sign-in during onboarding doesn't lose the user's persona answers.
export async function flushPendingPersona(userId: string): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(PENDING_PERSONA_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let persona: OnboardingPersistState['persona'];
  try {
    persona = JSON.parse(raw) as OnboardingPersistState['persona'];
  } catch {
    await AsyncStorage.removeItem(PENDING_PERSONA_KEY).catch(() => {});
    return;
  }
  await persistOnboardingPersona(userId, persona);
  await AsyncStorage.removeItem(PENDING_PERSONA_KEY).catch(() => {});
}

// Back-compat wrapper. New callers should split the two halves explicitly
// (connections eager, persona conditional). Left here so existing call
// sites don't break.
export async function persistOnboardingState(
  userId: string,
  state: OnboardingPersistState,
): Promise<void> {
  await Promise.all([
    persistOnboardingConnections(state),
    persistOnboardingPersona(userId, state.persona),
  ]);
}
