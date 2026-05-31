// Mock the native-module-touching transitive imports so the pure
// todayInCopenhagen can be imported in Jest (matches sibling test convention).
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

import { todayInCopenhagen } from '../profile-extractor';

describe('todayInCopenhagen', () => {
  it('returns the same calendar day before the Copenhagen midnight boundary', () => {
    // 21:30 UTC = 23:30 Copenhagen (CEST, +02:00) -> still 2026-05-31.
    expect(todayInCopenhagen(new Date('2026-05-31T21:30:00Z'))).toBe('2026-05-31');
  });

  it('rolls over to the next day after crossing Copenhagen midnight', () => {
    // 23:30 UTC = 01:30 Copenhagen next day (CEST, +02:00) -> 2026-06-01.
    expect(todayInCopenhagen(new Date('2026-05-31T23:30:00Z'))).toBe('2026-06-01');
  });
});
