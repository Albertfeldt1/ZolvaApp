import {
  ActionType,
  DEFAULT_POLICY,
  PolicyMode,
  UserPolicyRow,
} from './types.ts';

export function resolvePolicy(
  actionType: ActionType,
  rows: UserPolicyRow[],
): PolicyMode {
  const row = rows.find((r) => r.action_type === actionType);
  return row?.mode ?? DEFAULT_POLICY[actionType];
}
