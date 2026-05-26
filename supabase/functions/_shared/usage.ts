// Per-call AI usage recorder. Inserts a row in ai_usage_events tagged with the
// calling surface so per-feature spend is attributable. Safe to ignore failures —
// usage telemetry must never break the surface that called it.

// Accept any supabase-js client; we only need .rpc() to be callable and
// thenable. Typing this against the exact SupabaseClient generic is brittle
// across versions.
// deno-lint-ignore no-explicit-any
export type UsageClient = { rpc: (name: string, args: Record<string, unknown>) => any };

export interface AiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export async function recordAiUsage(
  client: UsageClient,
  userId: string | null | undefined,
  surface: string,
  model: string | null | undefined,
  usage: AiUsage | null | undefined,
): Promise<void> {
  if (!userId || !surface) return;
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  if (input === 0 && output === 0) return;
  try {
    const r = await client.rpc('record_ai_usage', {
      p_user_id: userId,
      p_surface: surface,
      p_model: model ?? 'unknown',
      p_input_tokens: input,
      p_output_tokens: output,
    });
    if (r?.error) console.warn(`[usage] record_ai_usage failed surface=${surface}: ${r.error.message ?? ''}`);
  } catch (e) {
    console.warn(`[usage] record_ai_usage threw surface=${surface}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
