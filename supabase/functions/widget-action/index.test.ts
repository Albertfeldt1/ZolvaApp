import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { verifyJwt } from './jwt.ts';
import { workerHandler } from './index.ts';

Deno.test('verifyJwt rejects missing token', async () => {
  await assertRejects(() => verifyJwt(null), Error, 'missing');
});

Deno.test('verifyJwt rejects malformed token', async () => {
  await assertRejects(() => verifyJwt('not.a.jwt'), Error);
});

Deno.test('rejects missing Authorization header → 401 + logged out snippet', async () => {
  const res = await workerHandler(
    new Request('http://localhost/widget-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.snippet.mood, 'worried');
  assertEquals(body.snippet.deepLink, 'zolva://settings');
});
