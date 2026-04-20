// Per-user toggles for which notification types the user wants. Stored
// under a user-scoped AsyncStorage key so that signing out of account A
// and into B on the same device doesn't leak A's preferences to B. The
// auth module calls `hydrateNotificationSettingsForUser` on every session
// change to swap the cache.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type NotificationSettings = {
  reminders: boolean;
  digest: boolean;
  preAlerts: boolean;
  newMail: boolean;
};

const LEGACY_KEY = 'zolva.notifications.settings';
const MIGRATION_FLAG = 'zolva.migration.notifsettings-per-user.v1';
const scopedKey = (userId: string) => `zolva.notifications.settings.${userId}`;

const DEFAULTS: NotificationSettings = {
  reminders: false,
  digest: false,
  preAlerts: false,
  newMail: false,
};

let cache: NotificationSettings = DEFAULTS;
let currentUserId: string | null = null;
let hydrated = false;

const listeners = new Set<(s: NotificationSettings) => void>();

function notify() {
  const snapshot = cache;
  listeners.forEach((l) => l(snapshot));
}

function parse(raw: string | null): NotificationSettings {
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
    return {
      reminders: parsed.reminders === true,
      digest: parsed.digest === true,
      preAlerts: parsed.preAlerts === true,
      newMail: parsed.newMail === true,
    };
  } catch {
    return DEFAULTS;
  }
}

// On first run against the per-user scheme, copy the legacy global
// settings blob into the current user's scoped slot (so they don't lose
// their existing preferences on upgrade) and delete the global key so it
// can't leak across accounts. Guard with a flag; running twice would
// stamp account B with A's preferences.
async function migrateLegacyKey(userId: string): Promise<void> {
  try {
    const already = await AsyncStorage.getItem(MIGRATION_FLAG);
    if (already) return;

    const legacy = await AsyncStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const existingScoped = await AsyncStorage.getItem(scopedKey(userId));
      if (!existingScoped) {
        await AsyncStorage.setItem(scopedKey(userId), legacy);
      }
      await AsyncStorage.removeItem(LEGACY_KEY);
    }
    await AsyncStorage.setItem(MIGRATION_FLAG, '1');
  } catch (err) {
    if (__DEV__) console.warn('[notification-settings] legacy migration failed:', err);
  }
}

export async function hydrateNotificationSettingsForUser(
  userId: string | null,
): Promise<void> {
  currentUserId = userId;

  if (!userId) {
    cache = DEFAULTS;
    hydrated = true;
    notify();
    return;
  }

  try {
    await migrateLegacyKey(userId);
    const raw = await AsyncStorage.getItem(scopedKey(userId));
    cache = parse(raw);
  } catch (err) {
    if (__DEV__) console.warn('[notification-settings] hydrate failed:', err);
    cache = DEFAULTS;
  }
  hydrated = true;
  notify();
}

async function persist(): Promise<void> {
  if (!currentUserId) return;
  try {
    await AsyncStorage.setItem(scopedKey(currentUserId), JSON.stringify(cache));
  } catch (err) {
    if (__DEV__) console.warn('[notification-settings] persist failed:', err);
  }
}

// Kept as a compat entry point for App.tsx boot. Per-user hydration is
// driven by auth state changes, so this is a no-op — settings arrive as
// soon as the Supabase session resolves.
export function initNotificationSettings(): void {}

export function getNotificationSettings(): NotificationSettings {
  return cache;
}

export function subscribeNotificationSettings(
  listener: (s: NotificationSettings) => void,
): () => void {
  listeners.add(listener);
  listener(cache);
  return () => {
    listeners.delete(listener);
  };
}

export async function setNotificationSetting<K extends keyof NotificationSettings>(
  key: K,
  value: NotificationSettings[K],
): Promise<void> {
  if (!hydrated) {
    await hydrateNotificationSettingsForUser(currentUserId);
  }
  cache = { ...cache, [key]: value };
  notify();
  await persist();
}
