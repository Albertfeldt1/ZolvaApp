// src/lib/__tests__/gmail-date.test.ts
// parseGmailDate must order mail the way Gmail itself does: by internalDate
// (the server receive timestamp), NOT the sender-controlled `Date:` header.
// Regression guard for the "5 latest mails" chat list surfacing old marketing
// mail with fake-recent timestamps because their `Date:` header lied.
jest.mock('../auth', () => ({
  ProviderAuthError: class extends Error {},
  subscribeUserId: jest.fn(),
  tryWithRefresh: jest.fn(),
}));
jest.mock('../network-errors', () => ({
  fetchWithTimeout: jest.fn(),
  NetworkTimeoutError: class extends Error {},
}));

import { parseGmailDate } from '../gmail';

// 2026-05-24 09:00 UTC, the real receive time.
const RECEIVED_MS = Date.UTC(2026, 4, 24, 9, 0, 0);

describe('parseGmailDate', () => {
  it('uses internalDate over a disagreeing Date header (the bug)', () => {
    // Marketing sender claims "today 17:09" in the header, but Gmail received
    // it days earlier. The receive time must win so sorting stays truthful.
    const header = 'Fri, 29 May 2026 17:09:00 +0200';
    const d = parseGmailDate(header, String(RECEIVED_MS));
    expect(d.getTime()).toBe(RECEIVED_MS);
  });

  it('falls back to the Date header when internalDate is absent', () => {
    const header = 'Sun, 24 May 2026 09:00:00 +0000';
    const d = parseGmailDate(header, undefined);
    expect(d.getTime()).toBe(RECEIVED_MS);
  });

  it('falls back to the Date header when internalDate is not numeric', () => {
    const header = 'Sun, 24 May 2026 09:00:00 +0000';
    const d = parseGmailDate(header, 'not-a-number');
    expect(d.getTime()).toBe(RECEIVED_MS);
  });
});
