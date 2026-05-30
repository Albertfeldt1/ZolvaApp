// src/lib/widget-bridge.ts
//
// iOS-only. Writes the widget snapshot to the App Group container and asks
// WidgetKit to refresh. Android: no-op (Android widget arrives in a follow-up).

import { NativeModules, Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
  type BuildSnapshotInput,
  type PendingTrustOffer,
  buildSnapshotFromState,
} from './widget-snapshot';
import { supabase } from './supabase';

const APP_GROUP_ID = 'group.io.zolva.app';
const SNAPSHOT_FILENAME = 'widget-snapshot.json';

let lastWriteAt = 0;
const DEBOUNCE_MS = 5_000;

export async function writeSnapshot(input: BuildSnapshotInput): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const now = Date.now();
  if (now - lastWriteAt < DEBOUNCE_MS) return;
  lastWriteAt = now;

  const payload = buildSnapshotFromState(input);
  const json = JSON.stringify(payload);
  const dir = getAppGroupDir();
  if (!dir) return;
  try {
    new File(dir, SNAPSHOT_FILENAME).write(json);
    await reloadWidget();
  } catch (err) {
    if (__DEV__) console.warn('[widget-bridge] writeSnapshot failed:', err);
  }
}

function getAppGroupDir(): Directory | null {
  try {
    return Paths.appleSharedContainers[APP_GROUP_ID] ?? null;
  } catch {
    return null;
  }
}

async function reloadWidget(): Promise<void> {
  const bridge = NativeModules.ZolvaWidgetBridge as { reloadAllTimelines?: () => Promise<void> } | undefined;
  if (bridge?.reloadAllTimelines) {
    await bridge.reloadAllTimelines();
  }
}

// Newest pending trust-escalation offer for the user, or null. Centralized
// here (rather than per-caller) because every writer rebuilds the full
// snapshot from its own partial sources — fetching here keeps the offer
// present on every write regardless of which source last fired.
async function fetchPendingTrustOffer(userId: string): Promise<PendingTrustOffer | null> {
  try {
    const { data } = await supabase
      .from('trust_offers')
      .select('id, action_type, recipient, approval_count')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1);
    const row = data?.[0];
    if (!row) return null;
    return {
      id: row.id as string,
      actionType: row.action_type as string,
      recipient: row.recipient as string,
      approvalCount: row.approval_count as number,
    };
  } catch (err) {
    if (__DEV__) console.warn('[widget-bridge] trust offer fetch failed:', err);
    return null;
  }
}

// Sources of truth at write time. The wiring layer (App.tsx, hooks.ts)
// passes whatever it has in scope; missing pieces become null/[] and the
// widget falls through to a sensible state.
export type WriteSnapshotSources = {
  userId?: string | null;
  morningBriefHeadline?: string | null;
  eveningBriefHeadline?: string | null;
  events?: Array<{ id: string; start: Date; end: Date; title: string }>;
};

export async function writeSnapshotFromSources(s: WriteSnapshotSources): Promise<void> {
  const pendingTrustOffer = s.userId ? await fetchPendingTrustOffer(s.userId) : null;
  await writeSnapshot({
    now: new Date(),
    morningBrief: s.morningBriefHeadline ? { headline: s.morningBriefHeadline } : null,
    eveningBrief: s.eveningBriefHeadline ? { headline: s.eveningBriefHeadline } : null,
    events: s.events ?? [],
    pendingTrustOffer,
  });
}
