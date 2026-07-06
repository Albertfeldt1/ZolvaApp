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
// PAPIR_PREVIEW flag had — UNLESS the build was made with the papir-preview
// profile (see PAPIR_PREVIEW_BUILD below). Store builds from the production
// profile can never ship Papir-only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

// Preview builds: eas.json's "papir-preview" profile bakes
// EXPO_PUBLIC_PAPIR_PREVIEW=1 into the bundle so TestFlight can exercise
// Papir. No other profile sets it, so store builds keep the release
// guarantee above. Papir defaults ON in preview builds (that's their whole
// purpose); the PapirSettings "Skift til klassisk UI" switch still works
// and sticks across restarts.
export const PAPIR_PREVIEW_BUILD = process.env.EXPO_PUBLIC_PAPIR_PREVIEW === '1';

const KEY = 'zolva.dev.papirEnabled';

let cached = PAPIR_PREVIEW_BUILD;
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
    // '0' must override the preview-build default so "Skift til klassisk
    // UI" survives a restart; missing key keeps the build default.
    const next = raw === '1' ? true : raw === '0' ? false : cached;
    if (next !== cached) {
      cached = next;
      emit();
    }
  } catch {
    // Unreadable storage → stay on the build default; the Settings toggle
    // still works.
  }
}

/** Synchronous read (module cache; false until hydrated). Dev/preview-only. */
export function isPapirEnabled(): boolean {
  return (__DEV__ || PAPIR_PREVIEW_BUILD) && cached;
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

/** Reactive flag for App.tsx. Always false in store/release builds. */
export function usePapirEnabled(): boolean {
  const value = useSyncExternalStore(subscribe, () => cached);
  return (__DEV__ || PAPIR_PREVIEW_BUILD) && value;
}
