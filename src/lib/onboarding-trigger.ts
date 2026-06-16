export interface OnboardingTriggerInput {
  /** true when the signed-in user is the demo account. */
  isDemo: boolean;
  /** result of shouldShowV2OnboardingDevice() — device flag not yet set. */
  deviceShowPending: boolean;
  /** result of shouldShowV2Onboarding(uid) — per-uid flag not yet set. */
  uidShowPending: boolean;
}

export type OnboardingTriggerDecision = 'open' | 'skip' | 'mark-device-shown';

/**
 * Decides what to do with the onboarding wizard right after an auth
 * transition. 'open' shows the wizard; 'mark-device-shown' is the
 * port-forward case (returning user who saw onboarding under the old
 * per-uid system) — caller marks the device flag and does NOT open;
 * 'skip' does nothing.
 */
export function decideOnboardingTrigger(
  input: OnboardingTriggerInput,
): OnboardingTriggerDecision {
  if (input.isDemo) return 'skip';
  if (!input.deviceShowPending) return 'skip';
  if (!input.uidShowPending) return 'mark-device-shown';
  return 'open';
}
