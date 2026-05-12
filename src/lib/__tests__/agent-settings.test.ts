// Mock supabase before importing agent-settings.ts to avoid native-module
// errors in Jest. reduceAgentEnabled is a pure function and does not use it.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

import { reduceAgentEnabled } from '../agent-settings';

describe('reduceAgentEnabled', () => {
  it('defaults to true when remote returns null', () => {
    expect(reduceAgentEnabled({ remote: null, optimistic: null })).toBe(true);
  });

  it('uses remote when set and no optimistic value', () => {
    expect(reduceAgentEnabled({ remote: false, optimistic: null })).toBe(false);
  });

  it('optimistic overrides remote', () => {
    expect(reduceAgentEnabled({ remote: false, optimistic: true })).toBe(true);
    expect(reduceAgentEnabled({ remote: true, optimistic: false })).toBe(false);
  });
});
