// Mock the native-module-touching transitive imports so the pure
// computeFollowUpAt can be imported in Jest (matches sibling test convention).
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('../claude', () => ({ completeJson: jest.fn() }));
jest.mock('../hooks', () => ({ getPrivacyFlag: jest.fn() }));
jest.mock('../profile', () => ({ PROFILE_MEMORY_ENABLED: true, invalidatePreamble: jest.fn() }));
jest.mock('../profile-store', () => ({
  findDuplicateFact: jest.fn(),
  insertPendingFact: jest.fn(),
  listFacts: jest.fn(),
  normalizeFactText: jest.fn(),
}));

import { computeFollowUpAt } from '../profile-extractor';

describe('computeFollowUpAt', () => {
  it('returns the referent day at 00:00Z for an actionable dated fact (non-deadline text)', () => {
    expect(computeFollowUpAt('commitment', '2026-06-12', 'ring til Allan')?.toISOString())
      .toBe('2026-06-12T00:00:00.000Z');
    expect(computeFollowUpAt('other', '2026-06-12', 'middag med Sofie')?.toISOString())
      .toBe('2026-06-12T00:00:00.000Z');
  });

  it('returns null for non-actionable categories even with a date', () => {
    expect(computeFollowUpAt('preference', '2026-06-12', 'forny dit pas')).toBeNull();
    expect(computeFollowUpAt('relationship', '2026-06-12', 'forny dit pas')).toBeNull();
  });

  it('returns null when there is no valid referent date', () => {
    expect(computeFollowUpAt('commitment', null, 'forny dit pas')).toBeNull();
    expect(computeFollowUpAt('commitment', undefined, 'forny dit pas')).toBeNull();
    expect(computeFollowUpAt('commitment', 'fredag', 'forny dit pas')).toBeNull();
  });

  describe('14-day lead for deadline-like facts', () => {
    it('leads a renewal commitment by 14 days', () => {
      expect(computeFollowUpAt('commitment', '2026-06-12', 'Du skal forny dit pas')?.toISOString())
        .toBe('2026-05-29T00:00:00.000Z');
    });

    it('leads a bilsyn commitment by 14 days', () => {
      expect(computeFollowUpAt('commitment', '2026-10-01', 'bilsyn til oktober')?.toISOString())
        .toBe('2026-09-17T00:00:00.000Z');
    });

    it('leads an expiry (other) fact by 14 days', () => {
      expect(computeFollowUpAt('other', '2026-06-12', 'forsikring udløber')?.toISOString())
        .toBe('2026-05-29T00:00:00.000Z');
    });

    it('does NOT lead a non-deadline dated commitment', () => {
      expect(computeFollowUpAt('commitment', '2026-06-12', 'ring til Allan')?.toISOString())
        .toBe('2026-06-12T00:00:00.000Z');
    });

    it('does NOT lead a non-actionable category', () => {
      expect(computeFollowUpAt('preference', '2026-06-12', 'forsikring udløber')).toBeNull();
    });

    it('does NOT lead an undated deadline fact (stays null)', () => {
      expect(computeFollowUpAt('commitment', null, 'forny dit pas')).toBeNull();
    });
  });
});
