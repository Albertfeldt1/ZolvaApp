// Mock supabase + AsyncStorage before importing anything that touches them.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
// claude and hooks import auth.ts which calls supabase.auth at module load —
// mock at the module level so the transitive chain doesn't crash the suite.
jest.mock('../claude', () => ({ completeJson: jest.fn() }));
jest.mock('../hooks', () => ({ getPrivacyFlag: jest.fn() }));

import {
  buildCorrectionMessage,
  GENERIC_CONFUSED_FALLBACK,
} from '../chat-claim-guard';

describe('buildCorrectionMessage', () => {
  it('names the tool when known', () => {
    const out = buildCorrectionMessage('send_mail');
    expect(out).toContain("'send_mail'");
    expect(out).toContain('kaldte ikke værktøjet');
    expect(out).toContain('Påstå aldrig');
  });

  it('falls back to generic phrasing when tool is null', () => {
    const out = buildCorrectionMessage(null);
    expect(out).toContain('et værktøj');
    expect(out).not.toContain("''");
  });
});

describe('GENERIC_CONFUSED_FALLBACK', () => {
  it('is a non-empty Danish sentence', () => {
    expect(GENERIC_CONFUSED_FALLBACK.length).toBeGreaterThan(20);
    expect(GENERIC_CONFUSED_FALLBACK).toMatch(/forvirret|gentage/i);
  });
});
