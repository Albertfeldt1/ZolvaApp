// Mock the native-module-touching transitive imports so the pure
// shouldAutoConfirm can be imported in Jest (matches sibling test convention).
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

import { shouldAutoConfirm } from '../profile-extractor';

describe('shouldAutoConfirm', () => {
  it('returns true for confidence above the threshold', () => {
    expect(shouldAutoConfirm(0.9)).toBe(true);
  });

  it('returns true at the boundary (inclusive)', () => {
    expect(shouldAutoConfirm(0.85)).toBe(true);
  });

  it('returns false just below the threshold', () => {
    expect(shouldAutoConfirm(0.84)).toBe(false);
  });

  it('returns false at the insert-gate confidence', () => {
    expect(shouldAutoConfirm(0.6)).toBe(false);
  });
});
