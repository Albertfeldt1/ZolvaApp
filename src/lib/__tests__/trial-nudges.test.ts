// Mock native modules before any import that pulls them in transitively.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  SchedulableTriggerInputTypes: { DATE: 'date' },
  AndroidImportance: { DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
}));
jest.mock('react-native-purchases', () => ({
  default: { configure: jest.fn(), getCustomerInfo: jest.fn() },
}));
jest.mock('react-native-purchases-ui', () => ({
  default: { presentPaywallIfNeeded: jest.fn(), presentPaywall: jest.fn(), presentCustomerCenter: jest.fn() },
  PAYWALL_RESULT: { PURCHASED: 'PURCHASED', RESTORED: 'RESTORED', NOT_PRESENTED: 'NOT_PRESENTED' },
}));

import {
  skipperNudgeEligible,
  trialEndingBannerVisible,
  trialEndingFireDate,
  type PitchRecord,
} from '../trial-nudges';
import type { Entitlement } from '../entitlement';

const NOW = new Date('2026-06-10T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

const skipped = (at: string): PitchRecord => ({ at, outcome: 'skipped' });

describe('skipperNudgeEligible', () => {
  const base = { tier: 'free' as const, pitch: skipped(daysAgo(4)), dismissed: false, now: NOW };
  test('eligible: free, skipped ≥3d ago, not dismissed', () => {
    expect(skipperNudgeEligible(base)).toBe(true);
  });
  test('not eligible when tier is not free', () => {
    expect(skipperNudgeEligible({ ...base, tier: 'pro' })).toBe(false);
    expect(skipperNudgeEligible({ ...base, tier: 'lite' })).toBe(false);
  });
  test('not eligible when dismissed', () => {
    expect(skipperNudgeEligible({ ...base, dismissed: true })).toBe(false);
  });
  test('not eligible when pitch missing or started', () => {
    expect(skipperNudgeEligible({ ...base, pitch: null })).toBe(false);
    expect(skipperNudgeEligible({ ...base, pitch: { at: daysAgo(4), outcome: 'started' } })).toBe(false);
  });
  test('not eligible before 3 days, eligible at exactly 3', () => {
    expect(skipperNudgeEligible({ ...base, pitch: skipped(daysAgo(2)) })).toBe(false);
    expect(skipperNudgeEligible({ ...base, pitch: skipped(daysAgo(3)) })).toBe(true);
  });
});

const trialEnt = (endsInH: number): Entitlement => ({
  tier: 'pro', isTrial: true,
  trialEndsAt: new Date(NOW.getTime() + endsInH * 3600_000).toISOString(),
  periodEnd: null,
});

describe('trialEndingBannerVisible', () => {
  test('visible inside final 48h', () => {
    expect(trialEndingBannerVisible(trialEnt(47), NOW)).toBe(true);
    expect(trialEndingBannerVisible(trialEnt(1), NOW)).toBe(true);
  });
  test('visible at exactly 48h remaining', () => {
    expect(trialEndingBannerVisible(trialEnt(48), NOW)).toBe(true);
  });
  test('hidden before final 48h, after expiry, and off-trial', () => {
    expect(trialEndingBannerVisible(trialEnt(49), NOW)).toBe(false);
    expect(trialEndingBannerVisible(trialEnt(-1), NOW)).toBe(false);
    expect(trialEndingBannerVisible(
      { tier: 'pro', isTrial: false, trialEndsAt: null, periodEnd: null }, NOW,
    )).toBe(false);
  });
});

describe('trialEndingFireDate', () => {
  test('T−2d when in the future', () => {
    const ent = trialEnt(72);
    expect(trialEndingFireDate(ent, NOW)?.toISOString())
      .toBe(new Date(NOW.getTime() + 24 * 3600_000).toISOString());
  });
  test('null when T−2d already passed or not on trial', () => {
    expect(trialEndingFireDate(trialEnt(47), NOW)).toBeNull();
    expect(trialEndingFireDate(
      { tier: 'free', isTrial: false, trialEndsAt: null, periodEnd: null }, NOW,
    )).toBeNull();
  });
});
