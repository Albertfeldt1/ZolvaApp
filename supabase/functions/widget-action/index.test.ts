import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { verifyJwt } from './jwt.ts';

Deno.test('verifyJwt rejects missing token', async () => {
  await assertRejects(() => verifyJwt(null), Error, 'missing');
});

Deno.test('verifyJwt rejects malformed token', async () => {
  await assertRejects(() => verifyJwt('not.a.jwt'), Error);
});

// Real-token cases require a fixture signed with a known key. The cold-start
// JWKS fetch is exercised by an integration test in Task 24 (manual on-device
// QA) since the live JWKS is the source of truth.
