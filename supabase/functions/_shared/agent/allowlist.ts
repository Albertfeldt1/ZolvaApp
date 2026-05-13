// Recipient-pattern allowlist helper (spec §8.4).
//
// Auto-send is only permitted to recipients the user has personally
// corresponded with `threshold` times in the last `withinDays` days.
// Implemented as a cheap COUNT query against mail_events.provider_to,
// served by the partial index mail_events_user_to_occurred_idx.
//
// Fail-safe: any error (RLS, missing column, network) returns false so
// we fall back to the proposal path instead of auto-sending.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface HasRecipientHistoryArgs {
  userId: string;
  address: string;
  threshold: number;
  withinDays: number;
}

export async function hasRecipientHistory(
  client: SupabaseClient,
  args: HasRecipientHistoryArgs,
): Promise<boolean> {
  const normalized = args.address.trim().toLowerCase();
  if (!normalized) return false;
  const cutoff = new Date(Date.now() - args.withinDays * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = (await client
    .from('mail_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', args.userId)
    .eq('provider_to', normalized)
    .gte('occurred_at', cutoff)) as unknown as { count: number | null; error: Error | null };
  if (error || count == null) return false;
  return count >= args.threshold;
}
