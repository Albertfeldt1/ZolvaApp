// AsyncStorage-backed toggles for which notification types the user wants.
// Mirrors the subscribe/hydrate pattern in memory-store.ts so UI and the
// notifications module can both read the same source of truth.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type NotificationSettings = {
  reminders: boolean;
  digest: boolean;
  preAlerts: boolean;
  newMail: boolean;
};

const STORAGE_KEY = 'zolva.notifications.settings';
const DEFAULTS: NotificationSettings = {
  reminders: false,
  digest: false,
  preAlerts: false,
  newMail: false,
};

let cache: NotificationSettings = DEFAULTS;
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

const listeners = new Set<(s: NotificationSettings) => void>();

function notify() {
  const snapshot = cache;
  listeners.forEach((l) => l(snapshot));
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
        cache = {
          reminders: parsed.reminders === true,
          digest: parsed.digest === true,
          preAlerts: parsed.preAlerts === true,
          newMail: parsed.newMail === true,
        };
      }
    } catch (err) {
      if (__DEV__) console.warn('[notification-settings] hydrate failed:', err);
    }
    hydrated = true;
    notify();
  })();
  return hydrationPromise;
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (err) {
    if (__DEV__) console.warn('[notification-settings] persist failed:', err);
  }
}

export function initNotificationSettings(): void {
  void hydrate();
}

export function getNotificationSettings(): NotificationSettings {
  return cache;
}

export function subscribeNotificationSettings(
  listener: (s: NotificationSettings) => void,
): () => void {
  listeners.add(listener);
  void hydrate();
  listener(cache);
  return () => {
    listeners.delete(listener);
  };
}

export async function setNotificationSetting<K extends keyof NotificationSettings>(
  key: K,
  value: NotificationSettings[K],
): Promise<void> {
  await hydrate();
  cache = { ...cache, [key]: value };
  notify();
  await persist();
}
