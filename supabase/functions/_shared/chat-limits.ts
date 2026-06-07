// supabase/functions/_shared/chat-limits.ts
//
// Weekly chat message caps per tier. Pro is unlimited (null → skip the quota
// RPC entirely). Used by chat-run to gate round-0. The client never needs these
// numbers — it reacts to the server's 402 chat_quota response.
import type { Tier } from './entitlement.ts';

export const CHAT_WEEKLY_LIMITS: Record<'free' | 'lite', number> = {
  free: 50,
  lite: 300,
};

// null = unlimited (pro).
export function chatLimitForTier(tier: Tier): number | null {
  if (tier === 'pro') return null;
  return CHAT_WEEKLY_LIMITS[tier];
}
