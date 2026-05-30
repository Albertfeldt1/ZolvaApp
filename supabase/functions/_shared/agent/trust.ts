// supabase/functions/_shared/agent/trust.ts
//
// Trust-escalation pure logic. Two responsibilities:
//   1. resolveTrustPolicy() — given the user's active promotions and a
//      candidate (action_type, recipient), decide whether the per-
//      recipient override pins the policy to `auto`. Returns null when
//      no promotion applies, so the runner falls back to user_agent_policy.
//   2. shouldOfferPromotion() — given lifetime approval count for a slot
//      and the status of the most recent offer for that slot (or null),
//      decide whether agent-approve should insert a new pending offer.

import type { ActionType } from './types.ts';

export const TRUST_OFFER_THRESHOLD = 3;

export interface TrustPromotion {
  action_type: string;
  recipient: string;
}

export function resolveTrustPolicy(
  actionType: ActionType,
  recipient: string,
  promotions: TrustPromotion[],
): 'auto' | null {
  const target = recipient.toLowerCase();
  for (const p of promotions) {
    if (p.action_type === actionType && p.recipient.toLowerCase() === target) {
      return 'auto';
    }
  }
  return null;
}

// `latestOfferStatus` is the status of the most recent offer row for the
// same (user, action_type, recipient) slot — or null if no row exists.
// Active slots ('pending' | 'accepted') suppress new offers; terminal
// rows ('dismissed' | 'reverted') do NOT, so a renewed approval streak
// can create a fresh offer.
export function shouldOfferPromotion(
  approvalCount: number,
  latestOfferStatus: 'pending' | 'accepted' | 'dismissed' | 'reverted' | null,
): boolean {
  if (approvalCount < TRUST_OFFER_THRESHOLD) return false;
  if (latestOfferStatus === 'pending' || latestOfferStatus === 'accepted') return false;
  return true;
}
