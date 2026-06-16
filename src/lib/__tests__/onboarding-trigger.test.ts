import { decideOnboardingTrigger } from '../onboarding-trigger';

describe('decideOnboardingTrigger', () => {
  const base = { isDemo: false, deviceShowPending: true, uidShowPending: true };

  it('opens the wizard for a brand-new signed-in user', () => {
    expect(decideOnboardingTrigger(base)).toBe('open');
  });

  it('skips for a demo user', () => {
    expect(decideOnboardingTrigger({ ...base, isDemo: true })).toBe('skip');
  });

  it('skips (and ports the device flag) when the uid already saw onboarding', () => {
    expect(decideOnboardingTrigger({ ...base, uidShowPending: false })).toBe('mark-device-shown');
  });

  it('skips when the device flag is already marked', () => {
    expect(decideOnboardingTrigger({ ...base, deviceShowPending: false })).toBe('skip');
  });
});
