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
  it('returns the referent day at 00:00Z for an actionable dated fact', () => {
    expect(computeFollowUpAt('commitment', '2026-06-12')?.toISOString())
      .toBe('2026-06-12T00:00:00.000Z');
    expect(computeFollowUpAt('other', '2026-06-12')?.toISOString())
      .toBe('2026-06-12T00:00:00.000Z');
  });

  it('returns null for non-actionable categories even with a date', () => {
    expect(computeFollowUpAt('preference', '2026-06-12')).toBeNull();
    expect(computeFollowUpAt('relationship', '2026-06-12')).toBeNull();
  });

  it('returns null when there is no valid referent date', () => {
    expect(computeFollowUpAt('commitment', null)).toBeNull();
    expect(computeFollowUpAt('commitment', undefined)).toBeNull();
    expect(computeFollowUpAt('commitment', 'fredag')).toBeNull();
  });
});
