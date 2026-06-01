// gmail.ts pulls in ./auth (AsyncStorage, native) at import time — mock it so
// this unit test can load the module under jest. network-errors stays real so
// `instanceof NetworkTimeoutError` matches the class gmail.ts actually uses.
jest.mock('../auth', () => ({
  ProviderAuthError: class extends Error {},
  subscribeUserId: jest.fn(),
  tryWithRefresh: jest.fn(),
}));

import { fetchGoogleWithRetry, isTransientStatus } from '../gmail';
import { NetworkTimeoutError } from '../network-errors';

// Minimal Response stand-in — the retry loop only inspects `.status`.
const resp = (status: number) =>
  ({ status, ok: status >= 200 && status < 300 }) as Response;

const noSleep = () => Promise.resolve();

describe('isTransientStatus', () => {
  it('treats 429 (rate-limited) and 5xx as transient', () => {
    expect(isTransientStatus(429)).toBe(true);
    expect(isTransientStatus(500)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
  });

  it('does NOT treat success or auth/client errors as transient', () => {
    expect(isTransientStatus(200)).toBe(false);
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(403)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
  });
});

describe('fetchGoogleWithRetry', () => {
  // This is the regression guard for the fluctuating-inbox-count bug: a
  // transient 429 on a per-message metadata fetch must be retried, not
  // silently dropped (which made the mail count vary between refreshes).
  it('retries a transient 429 and returns the eventual success', async () => {
    const queue = [resp(429), resp(429), resp(200)];
    let i = 0;
    const fetcher = jest.fn(async () => queue[i++]);
    const res = await fetchGoogleWithRetry('url', {}, { fetcher, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retries a NetworkTimeoutError then succeeds', async () => {
    let i = 0;
    const fetcher = jest.fn(async () => {
      if (i++ === 0) throw new NetworkTimeoutError('google');
      return resp(200);
    });
    const res = await fetchGoogleWithRetry('url', {}, { fetcher, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries, returning the last failing response', async () => {
    const fetcher = jest.fn(async () => resp(429));
    const res = await fetchGoogleWithRetry('url', {}, { fetcher, sleep: noSleep, retries: 2 });
    expect(res.status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('does not retry a non-transient 404', async () => {
    const fetcher = jest.fn(async () => resp(404));
    const res = await fetchGoogleWithRetry('url', {}, { fetcher, sleep: noSleep });
    expect(res.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
