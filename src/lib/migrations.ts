// One-shot AsyncStorage cleanup. Runs once per install, guarded by a
// version flag so repeat app launches are free.

import AsyncStorage from '@react-native-async-storage/async-storage';

const MIGRATION_FLAG = 'zolva.migration.v1-user-scoped';

// Pre-user-scoping keys. Nothing reads these anymore — any surviving
// data belongs to a previous sign-in session and should be deleted.
const LEGACY_GLOBAL_KEYS = [
  'zolva.memory.reminders',
  'zolva.memory.notes',
  'zolva.chat.history',
  'zolva.prefs.work',
  'zolva.prefs.privacy',
];

let started = false;

export async function runStartupMigrations(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const done = await AsyncStorage.getItem(MIGRATION_FLAG);
    if (done) return;
    await AsyncStorage.multiRemove(LEGACY_GLOBAL_KEYS);
    await AsyncStorage.setItem(MIGRATION_FLAG, '1');
    if (__DEV__) console.log('[migrations] cleared legacy unscoped keys');
  } catch (err) {
    if (__DEV__) console.warn('[migrations] startup migration failed:', err);
  }
}
