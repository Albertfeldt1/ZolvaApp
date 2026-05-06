// Per-integration enabled flags.
//
// One OAuth grant covers all of a provider's scopes (Google: Gmail+Cal+Drive,
// Microsoft: Outlook Mail+Cal+OneDrive). There's no API to revoke a single
// scope, so "disconnect Gmail" without revoking Calendar means a local
// software toggle: keep the OAuth grant, but stop calling Gmail endpoints.
//
// Storage shape: only EXPLICIT user choices are persisted. Absence of a key
// means "follow parent token" — if the OAuth grant exists, the integration
// is effectively enabled. This makes the migration trivial (existing users
// see no change) and brand-new users see toggles flip ON the moment OAuth
// succeeds without an extra write.
//
// Reads are sync against a module-level cache populated at first awaited
// `loadIntegrationFlags()`. Writes go through `setIntegrationEnabled()`
// which updates cache, notifies subscribers, and persists.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import type { IntegrationKey } from './types';

const STORAGE_KEY = 'zolva.integrations.enabled.v1';

export type IntegrationFlags = Partial<Record<IntegrationKey, boolean>>;

let cache: IntegrationFlags = {};
let loaded = false;
let loadPromise: Promise<IntegrationFlags> | null = null;
const subscribers = new Set<(flags: IntegrationFlags) => void>();

export function loadIntegrationFlags(): Promise<IntegrationFlags> {
  if (loaded) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cache = parsed as IntegrationFlags;
        }
      }
    } catch {
      // Storage read failures default to empty cache — same effect as a
      // fresh install. No reason to crash here.
    }
    loaded = true;
    return cache;
  })();
  return loadPromise;
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Persistence failures are silent — the in-memory cache still reflects
    // the user's choice for this session. Worst case the toggle reverts on
    // next launch.
  }
}

function notify(): void {
  const snapshot = { ...cache };
  for (const sub of subscribers) sub(snapshot);
}

// Sync read of the raw flag. Use isIntegrationEffectivelyEnabled() when you
// also know whether the parent OAuth grant exists.
export function getIntegrationFlag(id: IntegrationKey): boolean | undefined {
  return cache[id];
}

// "Effectively enabled" combines parent-token presence with the user's
// explicit choice:
//   - flag === false      → disabled (user turned it off)
//   - flag === true        → enabled if parent token also exists
//   - flag === undefined   → enabled if parent token exists (default-on)
export function isIntegrationEffectivelyEnabled(
  id: IntegrationKey,
  parentTokenPresent: boolean,
): boolean {
  if (!parentTokenPresent) return false;
  return cache[id] !== false;
}

export async function setIntegrationEnabled(
  id: IntegrationKey,
  value: boolean,
): Promise<void> {
  // Persist explicit choices in both directions. Storing `true` (rather than
  // deleting the key) lets callers distinguish "user opted in" from "never
  // touched" if we ever need that signal later.
  cache = { ...cache, [id]: value };
  notify();
  await persist();
}

// Reset entirely — used by full provider revoke ("Fjern Google-konto helt").
// Clears all child flags so the next OAuth re-grant starts from a clean
// default-on state.
export async function clearIntegrationFlags(ids: IntegrationKey[]): Promise<void> {
  const next: IntegrationFlags = { ...cache };
  let changed = false;
  for (const id of ids) {
    if (id in next) {
      delete next[id];
      changed = true;
    }
  }
  if (!changed) return;
  cache = next;
  notify();
  await persist();
}

export function useIntegrationFlags(): {
  flags: IntegrationFlags;
  isEnabled: (id: IntegrationKey, parentTokenPresent: boolean) => boolean;
  setEnabled: (id: IntegrationKey, value: boolean) => Promise<void>;
} {
  const [flags, setFlags] = useState<IntegrationFlags>(cache);
  useEffect(() => {
    let cancelled = false;
    void loadIntegrationFlags().then((current) => {
      if (!cancelled) setFlags({ ...current });
    });
    const sub = (next: IntegrationFlags) => setFlags(next);
    subscribers.add(sub);
    return () => {
      cancelled = true;
      subscribers.delete(sub);
    };
  }, []);
  return {
    flags,
    isEnabled: (id, parentTokenPresent) =>
      parentTokenPresent && flags[id] !== false,
    setEnabled: setIntegrationEnabled,
  };
}
