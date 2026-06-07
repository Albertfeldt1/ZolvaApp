// supabase/functions/_shared/entitlement-read.ts
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rowToState, type EntitlementState } from './entitlement.ts';

// Reads a user's tier from the source-of-truth table. Returns the free
// baseline when no row exists. Used by agent-tick / chat gating (sub-project #2).
export async function getEntitlement(
  client: SupabaseClient,
  userId: string,
): Promise<EntitlementState> {
  const { data } = await client
    .from('user_entitlements')
    .select('tier,is_trial,current_period_end,store,product_id')
    .eq('user_id', userId)
    .maybeSingle();
  return rowToState(data as Partial<EntitlementState> | null);
}
