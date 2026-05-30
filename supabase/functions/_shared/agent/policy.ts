import {
  ActionType,
  DEFAULT_POLICY,
  PolicyMode,
  UserPolicyRow,
} from './types.ts';
import { resolveTrustPolicy, type TrustPromotion } from './trust.ts';

export function resolvePolicy(
  actionType: ActionType,
  rows: UserPolicyRow[],
  context?: { recipient?: string; promotions?: TrustPromotion[] },
): PolicyMode {
  // Trust-escalation override: per-recipient accepted promotions take
  // precedence over the action-level user_agent_policy. Only applied when
  // both a recipient AND a promotions list are passed by the caller —
  // existing callers without context get the original behavior.
  if (context?.recipient && context.promotions) {
    const trust = resolveTrustPolicy(actionType, context.recipient, context.promotions);
    if (trust === 'auto') return 'auto';
  }
  const row = rows.find((r) => r.action_type === actionType);
  return row?.mode ?? DEFAULT_POLICY[actionType];
}
