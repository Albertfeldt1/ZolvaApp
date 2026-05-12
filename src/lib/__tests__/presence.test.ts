// Mock react-native and supabase before importing presence.ts to avoid
// native-module errors in Jest. buildPresencePayload is a pure function
// so neither mock is exercised by the tests below.
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

import { buildPresencePayload } from '../presence';

describe('buildPresencePayload', () => {
  it('returns last_active_at = now for foreground event', () => {
    const now = new Date('2026-05-11T18:00:00Z');
    expect(buildPresencePayload('foreground', 'user-1', now)).toEqual({
      user_id: 'user-1',
      last_active_at: '2026-05-11T18:00:00.000Z',
      last_app_open_at: '2026-05-11T18:00:00.000Z',
    });
  });

  it('returns last_active_at = now without bumping app_open for background', () => {
    const now = new Date('2026-05-11T18:01:00Z');
    expect(buildPresencePayload('background', 'user-1', now)).toEqual({
      user_id: 'user-1',
      last_active_at: '2026-05-11T18:01:00.000Z',
    });
  });
});
