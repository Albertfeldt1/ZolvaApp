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

export async function persistOnboardingState(
  userId: string,
  state: OnboardingPersistState,
): Promise<void> {
  // 1. Integration flags. Only write rows where the user actually expressed
  //    intent; absence stays "follow parent token" (default-on once OAuth
  //    grants land), matching the rest of integration-flags semantics.
  const integrationWrites: Promise<void>[] = [];
  for (const [sourceId, value] of Object.entries(state.connections ?? {})) {
    const key = SOURCE_TO_INTEGRATION[sourceId];
    if (!key || typeof value !== 'boolean') continue;
    integrationWrites.push(
      setIntegrationEnabled(key, value).catch((err) => {
        if (__DEV__) console.warn(`[onboarding-persist] integration ${key} failed:`, err);
      }),
    );
  }

  // 2. Work preferences. Map onboarding ids → table values, then upsert each
  //    row + mirror to the per-user AsyncStorage cache useWorkPreferences
  //    reads on mount (otherwise Settings shows stale defaults until the
  //    next supabase round-trip lands).
  const prefRows: Array<{ id: WorkPreferenceId; value: string }> = [];
  if (state.persona.autonomy) {
    const v = AUTONOMY_VALUE[state.persona.autonomy];
    if (v) prefRows.push({ id: 'autonomy', value: v });
  }
  if (state.persona.tone) {
    const v = TONE_VALUE[state.persona.tone];
    if (v) prefRows.push({ id: 'tone', value: v });
  }
  if (state.persona.morning_brief) {
    const v = MORNING_BRIEF_VALUE[state.persona.morning_brief];
    if (v) prefRows.push({ id: 'morning-brief', value: v });
  }

  const prefWrite = (async () => {
    if (prefRows.length === 0) return;
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
    // Mirror to AsyncStorage cache. We merge into whatever's already there
    // rather than overwriting - other prefs (midday-brief, quiet-hours,
    // evening-brief) might have been seeded already and we don't want to
    // wipe them just because onboarding only touched three keys.
    try {
      const raw = await AsyncStorage.getItem(workPrefsKey(userId));
      const existing: Record<string, string> = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      for (const r of prefRows) existing[r.id] = r.value;
      await AsyncStorage.setItem(workPrefsKey(userId), JSON.stringify(existing));
    } catch (err) {
      if (__DEV__) console.warn('[onboarding-persist] cache write failed:', err);
    }
  })();

  await Promise.all([...integrationWrites, prefWrite]);
}
