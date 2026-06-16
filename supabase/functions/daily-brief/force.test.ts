import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseForceRequest, kindForHour, fetchLiveUnread, type LiveUnreadDeps } from './force.ts';

Deno.test('parseForceRequest: force=true on user path', () => {
  assertEquals(parseForceRequest({ force: true }, false), true);
});

Deno.test('parseForceRequest: cron path always ignores force', () => {
  assertEquals(parseForceRequest({ force: true }, true), false);
});

Deno.test('parseForceRequest: missing/malformed bodies are not forced', () => {
  assertEquals(parseForceRequest(null, false), false);
  assertEquals(parseForceRequest(undefined, false), false);
  assertEquals(parseForceRequest('force', false), false);
  assertEquals(parseForceRequest({ force: 'true' }, false), false);
  assertEquals(parseForceRequest({}, false), false);
});

Deno.test('kindForHour boundaries', () => {
  assertEquals(kindForHour(0), 'morning');
  assertEquals(kindForHour(11), 'morning');
  assertEquals(kindForHour(12), 'midday');
  assertEquals(kindForHour(16), 'midday');
  assertEquals(kindForHour(17), 'evening');
  assertEquals(kindForHour(23), 'evening');
});

function deps(overrides: Partial<LiveUnreadDeps> = {}): LiveUnreadDeps {
  return {
    loadRefreshToken: () => Promise.resolve('rt'),
    refreshAccessToken: () => Promise.resolve({ accessToken: 'at', expiresIn: 3600 }),
    fetchGmail: () => Promise.resolve([
      { from: 'Marie <marie@x.dk>', subject: 'Kontrakt' },
      { from: 'Jonas <jonas@x.dk>', subject: 'Faktura' },
    ]),
    fetchGraph: () => Promise.resolve([]),
    ...overrides,
  };
}

Deno.test('fetchLiveUnread: maps google candidates to unread shape', async () => {
  const out = await fetchLiveUnread(deps(), {} as never, 'u1', 'me@x.dk');
  assertEquals(out, [
    { from: 'Marie <marie@x.dk>', subject: 'Kontrakt' },
    { from: 'Jonas <jonas@x.dk>', subject: 'Faktura' },
  ]);
});

Deno.test('fetchLiveUnread: falls through to microsoft when google has no token', async () => {
  const out = await fetchLiveUnread(
    deps({
      loadRefreshToken: (_c, _u, p) => Promise.resolve(p === 'microsoft' ? 'rt' : null),
      fetchGraph: () => Promise.resolve([{ from: 'A', subject: 'B' }]),
    }),
    {} as never, 'u1', 'me@x.dk',
  );
  assertEquals(out, [{ from: 'A', subject: 'B' }]);
});

Deno.test('fetchLiveUnread: provider errors are swallowed, returns []', async () => {
  const out = await fetchLiveUnread(
    deps({
      refreshAccessToken: () => Promise.reject(new Error('AADSTS')),
      fetchGmail: () => Promise.reject(new Error('500')),
    }),
    {} as never, 'u1', 'me@x.dk',
  );
  assertEquals(out, []);
});

Deno.test('fetchLiveUnread: falls back to icloud when no oauth token exists', async () => {
  const out = await fetchLiveUnread(
    deps({
      loadRefreshToken: () => Promise.resolve(null),
      fetchIcloud: () => Promise.resolve([{ from: 'Mor <mor@me.com>', subject: 'Frokost' }]),
    }),
    {} as never, 'u1', 'me@me.com',
  );
  assertEquals(out, [{ from: 'Mor <mor@me.com>', subject: 'Frokost' }]);
});

Deno.test('fetchLiveUnread: skips icloud when an oauth provider already yielded', async () => {
  let icloudCalled = false;
  const out = await fetchLiveUnread(
    deps({
      fetchIcloud: () => {
        icloudCalled = true;
        return Promise.resolve([{ from: 'x', subject: 'y' }]);
      },
    }),
    {} as never, 'u1', 'me@x.dk',
  );
  assertEquals(icloudCalled, false);
  assertEquals(out.length, 2);
});

Deno.test('fetchLiveUnread: icloud errors are swallowed, returns []', async () => {
  const out = await fetchLiveUnread(
    deps({
      loadRefreshToken: () => Promise.resolve(null),
      fetchIcloud: () => Promise.reject(new Error('icloud fetch deadline 60000ms exceeded')),
    }),
    {} as never, 'u1', 'me@me.com',
  );
  assertEquals(out, []);
});

Deno.test('fetchLiveUnread: icloud results capped at 3 and blanks filled', async () => {
  const out = await fetchLiveUnread(
    deps({
      loadRefreshToken: () => Promise.resolve(null),
      fetchIcloud: () => Promise.resolve([
        { from: '', subject: '' }, { from: 'b', subject: 's2' },
        { from: 'c', subject: 's3' }, { from: 'd', subject: 's4' },
      ]),
    }),
    {} as never, 'u1', 'me@me.com',
  );
  assertEquals(out.length, 3);
  assertEquals(out[0], { from: 'ukendt', subject: '(intet emne)' });
});

Deno.test('fetchLiveUnread: caps at 3 and fills blanks', async () => {
  const out = await fetchLiveUnread(
    deps({
      fetchGmail: () => Promise.resolve([
        { from: '', subject: '' }, { from: 'b', subject: 's2' },
        { from: 'c', subject: 's3' }, { from: 'd', subject: 's4' },
      ]),
    }),
    {} as never, 'u1', 'me@x.dk',
  );
  assertEquals(out.length, 3);
  assertEquals(out[0], { from: 'ukendt', subject: '(intet emne)' });
});
