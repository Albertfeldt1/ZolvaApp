// Mock react and supabase before importing agent-settings.ts to avoid
// hook and native-module errors in Jest. reduceAgentEnabled is a pure function
// so neither mock is exercised by the tests below.
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useCallback: (fn: unknown) => fn,
  useEffect: jest.fn(),
  useState: (init: unknown) => [init, jest.fn()],
}));
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
