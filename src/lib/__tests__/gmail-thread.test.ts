// src/lib/__tests__/gmail-thread.test.ts
// dedupeByThread mirrors Gmail's one-row-per-conversation inbox grouping, so a
// multi-message thread (e.g. two Google security alerts) doesn't fill several
// "last N mails" slots and push distinct mail (Supabase Auth) off the list.
jest.mock('../auth', () => ({
  ProviderAuthError: class extends Error {},
  subscribeUserId: jest.fn(),
  tryWithRefresh: jest.fn(),
}));
jest.mock('../network-errors', () => ({
  fetchWithTimeout: jest.fn(),
  NetworkTimeoutError: class extends Error {},
}));

import { dedupeByThread } from '../gmail';

describe('dedupeByThread', () => {
  it('keeps one entry per thread, preserving the most-recent-first order', () => {
    // internalDate-descending, as Gmail returns it.
    const list = [
      { id: 'g-today', threadId: 't-grant' }, // Google 13.14
      { id: 'g-1724', threadId: 't-sec' }, // Google security thread, newer msg
      { id: 'g-1715', threadId: 't-sec' }, // same thread, older msg
      { id: 'supabase', threadId: 't-supabase' }, // Supabase Auth
    ];
    const out = dedupeByThread(list).map((m) => m.id);
    expect(out).toEqual(['g-today', 'g-1724', 'supabase']);
  });

  it('falls back to id when threadId is absent', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'a' }];
    expect(dedupeByThread(list).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('is a no-op when every message is its own thread', () => {
    const list = [
      { id: 'a', threadId: 'ta' },
      { id: 'b', threadId: 'tb' },
    ];
    expect(dedupeByThread(list)).toHaveLength(2);
  });
});
