// supabase/functions/_shared/entitlement.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { tierFromEntitlementIds, eventToOutcome, rowToState, shouldApplyRcEvent } from './entitlement.ts';

Deno.test('tierFromEntitlementIds prefers pro over lite', () => {
  assertEquals(tierFromEntitlementIds(['lite', 'pro']), 'pro');
  assertEquals(tierFromEntitlementIds(['lite']), 'lite');
  assertEquals(tierFromEntitlementIds([]), 'free');
  assertEquals(tierFromEntitlementIds(null), 'free');
});

const UID = '5d9ef13e-7f5a-40b1-907b-31d0abb7e415';

Deno.test('INITIAL_PURCHASE on trial -> upsert pro is_trial true', () => {
  const out = eventToOutcome({
    type: 'INITIAL_PURCHASE', app_user_id: UID, entitlement_ids: ['pro'],
    period_type: 'TRIAL', expiration_at_ms: 1_700_000_000_000,
    store: 'APP_STORE', product_id: 'pro_monthly',
  });
  assertEquals(out, {
    action: 'upsert', userId: UID,
    state: {
      tier: 'pro', is_trial: true,
      current_period_end: new Date(1_700_000_000_000).toISOString(),
      store: 'APP_STORE', product_id: 'pro_monthly',
    },
  });
});

Deno.test('RENEWAL normal lite -> upsert lite is_trial false', () => {
  const out = eventToOutcome({
    type: 'RENEWAL', app_user_id: UID, entitlement_ids: ['lite'],
    period_type: 'NORMAL', expiration_at_ms: null, store: 'PLAY_STORE', product_id: 'lite_monthly',
  });
  assertEquals(out.action, 'upsert');
  if (out.action === 'upsert') {
    assertEquals(out.state.tier, 'lite');
    assertEquals(out.state.is_trial, false);
    assertEquals(out.state.current_period_end, null);
  }
});

Deno.test('EXPIRATION -> expire', () => {
  assertEquals(
    eventToOutcome({ type: 'EXPIRATION', app_user_id: UID, entitlement_ids: ['pro'] }),
    { action: 'expire', userId: UID },
  );
});

Deno.test('CANCELLATION -> ignore (still entitled until expiration)', () => {
  const out = eventToOutcome({ type: 'CANCELLATION', app_user_id: UID, entitlement_ids: ['pro'] });
  assertEquals(out.action, 'ignore');
});

Deno.test('anonymous app_user_id -> ignore', () => {
  const out = eventToOutcome({
    type: 'INITIAL_PURCHASE', app_user_id: '$RCAnonymousID:abc', entitlement_ids: ['pro'],
  });
  assertEquals(out.action, 'ignore');
});

Deno.test('active event with unknown entitlement -> expire to free', () => {
  const out = eventToOutcome({ type: 'RENEWAL', app_user_id: UID, entitlement_ids: [] });
  assertEquals(out, { action: 'expire', userId: UID });
});

Deno.test('rowToState null -> free', () => {
  assertEquals(rowToState(null), {
    tier: 'free', is_trial: false, current_period_end: null, store: null, product_id: null,
  });
});

Deno.test('rowToState maps a row', () => {
  assertEquals(
    rowToState({ tier: 'pro', is_trial: true, current_period_end: '2026-01-01T00:00:00.000Z', store: 'APP_STORE', product_id: 'pro_monthly' }),
    { tier: 'pro', is_trial: true, current_period_end: '2026-01-01T00:00:00.000Z', store: 'APP_STORE', product_id: 'pro_monthly' },
  );
});

Deno.test('shouldApplyRcEvent: applies when nothing is stored yet', () => {
  assertEquals(shouldApplyRcEvent(123, null), true);
  assertEquals(shouldApplyRcEvent(123, undefined), true);
});

Deno.test('shouldApplyRcEvent: applies when the incoming event is newer or equal', () => {
  assertEquals(shouldApplyRcEvent(Date.parse('2026-06-15T11:00:00Z'), '2026-06-15T10:00:00Z'), true);
  // Equal timestamps (a plain redelivery) reapply identical state — harmless.
  assertEquals(shouldApplyRcEvent(Date.parse('2026-06-15T10:00:00Z'), '2026-06-15T10:00:00Z'), true);
});

Deno.test('shouldApplyRcEvent: skips a stale out-of-order event', () => {
  assertEquals(shouldApplyRcEvent(Date.parse('2026-06-15T09:00:00Z'), '2026-06-15T10:00:00Z'), false);
});

Deno.test('shouldApplyRcEvent: fail-open when the incoming timestamp is missing', () => {
  // Can't order without a timestamp — preserve last-write-wins rather than
  // silently dropping a write.
  assertEquals(shouldApplyRcEvent(null, '2026-06-15T10:00:00Z'), true);
  assertEquals(shouldApplyRcEvent(undefined, '2026-06-15T10:00:00Z'), true);
});
