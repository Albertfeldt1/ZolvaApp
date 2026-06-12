// Guards the user-controllable `model` + `max_tokens` on the chat proxies
// (claude-proxy, chat-run). Both forward these straight from the request body
// to Anthropic on the shared org key. Without this guard an authenticated user
// could POST an arbitrary/expensive model string or a huge max_tokens and run
// up unbounded cost. Allowlist = exactly the models the client legitimately
// sends; ceiling = the largest legit chat max_tokens (CHAT_MAX_TOKENS_RETRY).
//
// IMPORTANT: when you add a new model to the client chat path, add it here too,
// or the proxy will reject it with 400 model_not_allowed.

export const ALLOWED_CHAT_MODELS = new Set<string>([
  'claude-haiku-4-5-20251001', // default chat / drafts / memory
  'claude-sonnet-4-6', // CHAT_MODEL_HARD — long/hard chat turns
  'claude-opus-4-7', // legacy hard-turn model; kept allowlisted so pre-OTA clients still pass
]);

// Largest max_tokens the legit client asks for (hooks.ts CHAT_MAX_TOKENS_RETRY).
export const MAX_OUTPUT_TOKENS_CEILING = 8192;

export function isAllowedModel(model: string): boolean {
  return ALLOWED_CHAT_MODELS.has(model);
}

// Coerce a caller-supplied max_tokens to a sane positive int and clamp it to
// the ceiling. Falls back to `fallback` for missing/invalid input.
export function clampMaxTokens(requested: unknown, fallback: number): number {
  const n =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : fallback;
  return Math.min(n, MAX_OUTPUT_TOKENS_CEILING);
}
