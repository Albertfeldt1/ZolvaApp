// Mock the native modules notification-feed pulls in at import time; the pure
// helpers under test touch neither.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('../auth', () => ({ subscribeUserId: jest.fn() }));

import { coerceNotificationPayload, feedIdFor } from '../notification-feed';

describe('coerceNotificationPayload', () => {
  test('accepts every id-bearing type', () => {
    expect(coerceNotificationPayload({ type: 'reminder', reminderId: 'r1' })).toEqual({ type: 'reminder', reminderId: 'r1' });
    expect(coerceNotificationPayload({ type: 'newMail', provider: 'google', messageId: 'm1', threadId: 't1' }))
      .toEqual({ type: 'newMail', provider: 'google', messageId: 'm1', threadId: 't1' });
    expect(coerceNotificationPayload({ type: 'agent_proposal', action_id: 'a1' })).toEqual({ type: 'agent_proposal', action_id: 'a1' });
    expect(coerceNotificationPayload({ type: 'brief', briefId: 'b1' })).toEqual({ type: 'brief', briefId: 'b1' });
  });

  test('accepts trialEnding which carries no id', () => {
    expect(coerceNotificationPayload({ type: 'trialEnding' })).toEqual({ type: 'trialEnding' });
  });

  test('rejects junk and missing required fields', () => {
    expect(coerceNotificationPayload(null)).toBeNull();
    expect(coerceNotificationPayload({ type: 'nope' })).toBeNull();
    expect(coerceNotificationPayload({ type: 'reminder' })).toBeNull(); // missing reminderId
    expect(coerceNotificationPayload({ type: 'newMail', provider: 'aol', messageId: 'm' })).toBeNull(); // bad provider
  });
});

describe('feedIdFor', () => {
  test('is deterministic and type-scoped so receive + tap dedupe to one entry', () => {
    expect(feedIdFor({ type: 'reminder', reminderId: 'r1' })).toBe('reminder:r1');
    expect(feedIdFor({ type: 'newMail', provider: 'google', messageId: 'm1' })).toBe('newMail:google:m1');
    expect(feedIdFor({ type: 'agent_proposal', action_id: 'a1' })).toBe('agent_proposal:a1');
    expect(feedIdFor({ type: 'trialEnding' })).toBe('trialEnding');
  });
});
