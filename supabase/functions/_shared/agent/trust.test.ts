// supabase/functions/_shared/agent/trust.test.ts

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  resolveTrustPolicy,
  shouldOfferPromotion,
  TRUST_OFFER_THRESHOLD,
} from './trust.ts';

Deno.test('resolveTrustPolicy: accepted promotion for matching recipient returns auto', () => {
  const promotions = [
    { action_type: 'mail.send_reply', recipient: 'mom@example.com' },
  ];
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'mom@example.com', promotions),
    'auto',
  );
});

Deno.test('resolveTrustPolicy: case-insensitive recipient match', () => {
  const promotions = [
    { action_type: 'mail.send_reply', recipient: 'Mom@Example.com' },
  ];
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'mom@EXAMPLE.com', promotions),
    'auto',
  );
});

Deno.test('resolveTrustPolicy: no promotion returns null (caller falls back to user_agent_policy)', () => {
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'mom@example.com', []),
    null,
  );
});

Deno.test('resolveTrustPolicy: different recipient does NOT match', () => {
  const promotions = [
    { action_type: 'mail.send_reply', recipient: 'mom@example.com' },
  ];
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'dad@example.com', promotions),
    null,
  );
});

Deno.test('resolveTrustPolicy: different action_type does NOT match', () => {
  const promotions = [
    { action_type: 'mail.archive', recipient: 'mom@example.com' },
  ];
  assertEquals(
    resolveTrustPolicy('mail.send_reply', 'mom@example.com', promotions),
    null,
  );
});

Deno.test('shouldOfferPromotion: threshold exactly hit, no prior offer -> true', () => {
  assertEquals(shouldOfferPromotion(TRUST_OFFER_THRESHOLD, null), true);
});

Deno.test('shouldOfferPromotion: above threshold, no prior offer -> true', () => {
  assertEquals(shouldOfferPromotion(TRUST_OFFER_THRESHOLD + 5, null), true);
});

Deno.test('shouldOfferPromotion: below threshold -> false', () => {
  assertEquals(shouldOfferPromotion(TRUST_OFFER_THRESHOLD - 1, null), false);
});

Deno.test('shouldOfferPromotion: pending offer already exists -> false (no double-prompt)', () => {
  assertEquals(shouldOfferPromotion(10, 'pending'), false);
});

Deno.test('shouldOfferPromotion: accepted offer already exists -> false (already auto)', () => {
  assertEquals(shouldOfferPromotion(10, 'accepted'), false);
});

Deno.test('shouldOfferPromotion: dismissed offer present -> true (user may have changed mind)', () => {
  assertEquals(shouldOfferPromotion(10, 'dismissed'), true);
});

Deno.test('shouldOfferPromotion: reverted offer present -> true (user may have changed mind)', () => {
  assertEquals(shouldOfferPromotion(10, 'reverted'), true);
});
