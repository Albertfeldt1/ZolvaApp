// supabase/functions/revenuecat-webhook/handler.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { handleWebhook, type WebhookDeps } from './handler.ts';

const UID = '5d9ef13e-7f5a-40b1-907b-31d0abb7e415';

function fakeDeps(): WebhookDeps & { upserts: unknown[]; expires: string[]; nonPro: string[] } {
  const upserts: unknown[] = [];
  const expires: string[] = [];
  const nonPro: string[] = [];
  return {
    secret: 'shh',
    upserts, expires, nonPro,
    upsert: async (userId, state) => { upserts.push({ userId, state }); },
    expire: async (userId) => { expires.push(userId); },
    onNonPro: async (userId) => { nonPro.push(userId); },
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
  const captured = deps.upserts[0] as { userId: string; state: { tier: string; is_trial: boolean } };
  assertEquals(captured.userId, UID);
  assertEquals(captured.state.tier, 'pro');
  assertEquals(captured.state.is_trial, true);
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

Deno.test('onNonPro fires on EXPIRATION so open loops get expired', async () => {
  const deps = fakeDeps();
  await handleWebhook('shh', { event: { type: 'EXPIRATION', app_user_id: UID, entitlement_ids: ['pro'] } }, deps);
  assertEquals(deps.nonPro, [UID]);
});

Deno.test('onNonPro fires when a renewal downgrades pro -> lite', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', {
    event: { type: 'RENEWAL', app_user_id: UID, entitlement_ids: ['lite'], product_id: 'lite_monthly' },
  }, deps);
  assertEquals(res.status, 200);
  assertEquals((deps.upserts[0] as { state: { tier: string } }).state.tier, 'lite');
  assertEquals(deps.nonPro, [UID]);
});

Deno.test('onNonPro does NOT fire on a pro renewal', async () => {
  const deps = fakeDeps();
  await handleWebhook('shh', { event: { type: 'RENEWAL', app_user_id: UID, entitlement_ids: ['pro'] } }, deps);
  assertEquals(deps.nonPro.length, 0);
});

Deno.test('onNonPro does NOT fire for a stale (skipped) event', async () => {
  const deps = fakeDeps();
  deps.readEventTimestamp = async () => '2026-06-15T12:00:00.000Z';
  await handleWebhook('shh', {
    event: { type: 'EXPIRATION', app_user_id: UID, event_timestamp_ms: Date.parse('2026-06-15T11:00:00Z') },
  }, deps);
  assertEquals(deps.nonPro.length, 0);
});

Deno.test('400 when payload has no event', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', {}, deps);
  assertEquals(res.status, 400);
});

Deno.test('skips a stale (out-of-order) event when a newer one was already applied', async () => {
  const deps = fakeDeps();
  deps.readEventTimestamp = async () => '2026-06-15T12:00:00.000Z'; // newer already stored
  const res = await handleWebhook('shh', {
    event: {
      type: 'EXPIRATION', app_user_id: UID,
      event_timestamp_ms: Date.parse('2026-06-15T11:00:00Z'), // older than stored
    },
  }, deps);
  assertEquals(res.status, 200);
  assertEquals(deps.expires.length, 0); // stale → not applied
  assertEquals(deps.upserts.length, 0);
});

Deno.test('applies an event newer than the stored one', async () => {
  const deps = fakeDeps();
  deps.readEventTimestamp = async () => '2026-06-15T10:00:00.000Z';
  const res = await handleWebhook('shh', {
    event: {
      type: 'RENEWAL', app_user_id: UID, entitlement_ids: ['pro'],
      event_timestamp_ms: Date.parse('2026-06-15T11:00:00Z'),
    },
  }, deps);
  assertEquals(res.status, 200);
  assertEquals(deps.upserts.length, 1);
});
