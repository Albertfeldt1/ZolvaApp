// supabase/functions/_shared/entitlement-pro.ts
//
// Proactive crons (commitments/reflect/memory-followups) are Pro-only. Split
// into a pure filter (unit-tested) + the IO that fetches the pro id set
// (smoke-tested against the live DB). A missing user_entitlements row means
// free, so only users with an explicit tier='pro' row pass.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function keepProUsers<T extends { userId: string }>(
  users: T[],
  proIds: Set<string>,
): T[] {
  return users.filter((u) => proIds.has(u.userId));
}

export async function proUserIdSet(
  client: SupabaseClient,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await client
    .from('user_entitlements')
    .select('user_id')
    .eq('tier', 'pro')
    .in('user_id', userIds);
  if (error) throw error;
  return new Set((data ?? []).map((r: { user_id: string }) => r.user_id));
}
