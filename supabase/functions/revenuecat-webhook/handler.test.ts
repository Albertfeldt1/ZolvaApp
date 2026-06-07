// supabase/functions/revenuecat-webhook/handler.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { handleWebhook, type WebhookDeps } from './handler.ts';

const UID = '5d9ef13e-7f5a-40b1-907b-31d0abb7e415';

function fakeDeps(): WebhookDeps & { upserts: unknown[]; expires: string[] } {
  const upserts: unknown[] = [];
  const expires: string[] = [];
  return {
    secret: 'shh',
    upserts, expires,
    upsert: async (userId, state) => { upserts.push({ userId, state }); },
    expire: async (userId) => { expires.push(userId); },
  };
}

Deno.test('rejects wrong auth header with 401', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('nope', { event: { type: 'RENEWAL', app_user_id: UID, entitlement_ids: ['pro'] } }, deps);
  assertEquals(res.status, 401);
  assertEquals(deps.upserts.length, 0);
});

Deno.test('upserts on a purchase event', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', {
    event: { type: 'INITIAL_PURCHASE', app_user_id: UID, entitlement_ids: ['pro'], period_type: 'TRIAL', product_id: 'pro_monthly' },
  }, deps);
  assertEquals(res.status, 200);
  assertEquals(deps.upserts.length, 1);
  assertEquals(deps.expires.length, 0);
});

Deno.test('expires on EXPIRATION', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', { event: { type: 'EXPIRATION', app_user_id: UID, entitlement_ids: ['pro'] } }, deps);
  assertEquals(res.status, 200);
  assertEquals(deps.expires, [UID]);
});

Deno.test('ignores cancellation without writing', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', { event: { type: 'CANCELLATION', app_user_id: UID, entitlement_ids: ['pro'] } }, deps);
  assertEquals(res.status, 200);
  assertEquals(deps.upserts.length, 0);
  assertEquals(deps.expires.length, 0);
});

Deno.test('400 when payload has no event', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', {}, deps);
  assertEquals(res.status, 400);
});
