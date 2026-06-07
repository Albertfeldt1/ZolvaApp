// supabase/functions/_shared/agent/tier-policy.ts
//
// Clamps a resolved policy mode by subscription tier. Applied AFTER
// resolvePolicy in the runner so it overrides both user overrides and trust
// promotions — a tier ceiling can never be lifted by per-recipient trust.
//
//   pro  → identity (full DEFAULT_POLICY + trust escalation).
//   lite → mail triage (read + propose), but NO auto-execution of any write:
//          sends downgraded to propose; calendar writes + nudges disabled.
//   free → everything off (defensive; free users are skipped at agent-tick
//          eligibility and never reach the runner).
import type { ActionType, PolicyMode } from './types.ts';
import type { Tier } from '../entitlement.ts';

// Lite is calendar-read-only and never sends nudges.
const LITE_DISABLED = new Set<ActionType>([
  'cal.create_event',
  'cal.update_event',
  'cal.rsvp',
  'nudge.push',
]);

// Lite may draft a reply, but it is surfaced for approval, never auto-sent.
const LITE_PROPOSE = new Set<ActionType>([
  'mail.send_reply',
  'mail.send_new',
]);

export function clampModeForTier(
  tier: Tier,
  action: ActionType,
  mode: PolicyMode,
): PolicyMode {
  if (tier === 'pro') return mode;
  if (tier === 'free') return 'off';
  // lite:
  if (LITE_DISABLED.has(action)) return 'off';
  if (LITE_PROPOSE.has(action)) return 'propose';
  return mode;
}
