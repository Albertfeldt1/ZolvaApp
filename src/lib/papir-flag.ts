// Dev-only runtime toggle for the Papir UI.
//
// Replaces the old PAPIR_PREVIEW boolean in index.ts: instead of swapping the
// root component at bundle time (which bypassed auth/providers entirely),
// App.tsx reads this flag AFTER boot and renders PapirRoot inside the real
// provider/auth tree. The flag is device-level (not per-user) because it is a
// developer switch, not user data.
//
// SAFETY: usePapirEnabled()/isPapirEnabled() hard-return false in release
// builds no matter what AsyncStorage says — same guarantee the __DEV__-gated
// PAPIR_PREVIEW flag had. A production build/OTA can never ship Papir-only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

const KEY = 'zolva.dev.papirEnabled';

let cached = false;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw === '1' && !cached) {
      cached = true;
      emit();
    }
  } catch {
    // Unreadable storage → stay off; the toggle in Settings still works.
  }
}

/** Synchronous read (module cache; false until hydrated). Dev-only. */
export function isPapirEnabled(): boolean {
  return __DEV__ && cached;
}

/** Flip the Papir UI on/off. Persists across restarts (dev builds only). */
export async function setPapirEnabled(value: boolean): Promise<void> {
  cached = value;
  emit();
  try {
    await AsyncStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    // In-memory flip already happened; persistence is best-effort.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void hydrate();
  return () => listeners.delete(listener);
}

/** Reactive flag for App.tsx. Always false in release builds. */
export function usePapirEnabled(): boolean {
  const value = useSyncExternalStore(subscribe, () => cached);
  return __DEV__ && value;
}
