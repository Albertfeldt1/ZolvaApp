// Per-user DAILY request ceiling for the anti-abuse limiter
// (check_and_incr_claude_usage), used by chat-run + claude-proxy. This protects
// the shared ANTHROPIC_API_KEY from a leaked token / scripted client / weekly-
// cap bypass running up cost. Free gets a tighter ceiling (well above realistic
// legit free usage — a full-week 50-message burst with tool rounds is ~150-200
// calls); paid tiers keep the original 500. The 60 RPM burst cap is unchanged
// for everyone.
import type { Tier } from './entitlement.ts';

export const RPM_LIMIT = 60;
const DAILY_CAP_FREE = 250;
const DAILY_CAP_PAID = 500;

export function dailyRequestCapForTier(tier: Tier): number {
  return tier === 'free' ? DAILY_CAP_FREE : DAILY_CAP_PAID;
}
