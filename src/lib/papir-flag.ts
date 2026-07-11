// Runtime toggle for the Papir UI.
//
// 2026-07-11: Papir is the DEFAULT UI in all builds (parity audit passed;
// voice-calendar labels intentionally dropped — replaced by our own flow).
// The classic UI remains as a user-reachable escape hatch via the
// "Skift til klassisk UI" row in PapirSettings; the classic SettingsScreen
// offers the way back. Remove the flag entirely when classic is deleted.
//
// App.tsx reads this flag AFTER boot and renders PapirRoot inside the real
// provider/auth tree. The flag is device-level (not per-user): it is a UI
// preference/escape hatch, not user data.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

// Kept for the (now redundant) papir-preview eas profile; existing TestFlight
// builds on that channel still bake this in. Harmless since Papir defaults on.
export const PAPIR_PREVIEW_BUILD = process.env.EXPO_PUBLIC_PAPIR_PREVIEW === '1';

const KEY = 'zolva.dev.papirEnabled';

// Papir on by default; AsyncStorage '0' (user chose classic) overrides.
let cached = true;
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
    // '0' must override the default so "Skift til klassisk UI" survives a
    // restart; missing key keeps the Papir default.
    const next = raw === '1' ? true : raw === '0' ? false : cached;
    if (next !== cached) {
      cached = next;
      emit();
    }
  } catch {
    // Unreadable storage → stay on the default; the Settings toggle
    // still works.
  }
}

/** Synchronous read (module cache; defaults to Papir until hydrated). */
export function isPapirEnabled(): boolean {
  return cached;
}

/** Flip the Papir UI on/off. Persists across restarts. */
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

/** Reactive flag for App.tsx. */
export function usePapirEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => cached);
}
