import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface BudgetSnapshot {
  inputTokens: number;
  outputTokens: number;
}

export interface BudgetLimits {
  dailyInput: number;
  dailyOutput: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  dailyInput: 500_000,
  dailyOutput: 125_000,
};

export function isBudgetExceeded(
  snap: BudgetSnapshot,
  limits: BudgetLimits,
): boolean {
  return snap.inputTokens >= limits.dailyInput
    || snap.outputTokens >= limits.dailyOutput;
}

// Load today's snapshot (UTC day) for a user. Returns zeros when no row exists.
export async function loadTodayBudget(
  client: SupabaseClient,
  userId: string,
): Promise<BudgetSnapshot> {
  const day = new Date().toISOString().slice(0, 10);
  const { data, error } = await client
    .from('user_agent_budget')
    .select('input_tokens, output_tokens')
    .eq('user_id', userId)
    .eq('day', day)
    .maybeSingle();
  if (error) throw error;
  return {
    inputTokens: data?.input_tokens ?? 0,
    outputTokens: data?.output_tokens ?? 0,
  };
}

// Idempotent additive upsert; safe under concurrent runs.
export async function incrementBudget(
  client: SupabaseClient,
  userId: string,
  add: BudgetSnapshot,
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const { error } = await client.rpc('agent_budget_increment', {
    p_user_id: userId,
    p_day: day,
    p_input: add.inputTokens,
    p_output: add.outputTokens,
  });
  if (error) throw error;
}
