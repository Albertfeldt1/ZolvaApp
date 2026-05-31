import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { selectDueFollowups, toFactDuePayload } from './followup-facts.ts';
import type { FollowupFactRow } from './followup-facts.ts';

function fact(over: Partial<FollowupFactRow>): FollowupFactRow {
  return {
    id: 'f1', text: 'du skal forny dit pas', category: 'commitment',
    follow_up_at: '2026-06-12T00:00:00Z', followed_up_at: null, status: 'confirmed',
    ...over,
  };
}

Deno.test('selectDueFollowups picks a confirmed, due, un-acted fact', () => {
  const now = new Date('2026-06-12T07:00:00Z');
  assertEquals(selectDueFollowups([fact({})], now).map((f) => f.id), ['f1']);
});

Deno.test('selectDueFollowups skips a fact not yet due', () => {
  const now = new Date('2026-06-11T07:00:00Z');
  assertEquals(selectDueFollowups([fact({})], now), []);
});

Deno.test('selectDueFollowups skips a fact already followed up', () => {
  const now = new Date('2026-06-12T07:00:00Z');
  assertEquals(selectDueFollowups([fact({ followed_up_at: '2026-06-12T06:00:00Z' })], now), []);
});

Deno.test('selectDueFollowups skips non-confirmed facts', () => {
  const now = new Date('2026-06-12T07:00:00Z');
  assertEquals(selectDueFollowups([fact({ status: 'pending' })], now), []);
});

Deno.test('selectDueFollowups skips null / invalid follow_up_at', () => {
  const now = new Date('2026-06-12T07:00:00Z');
  assertEquals(selectDueFollowups([fact({ follow_up_at: null })], now), []);
  assertEquals(selectDueFollowups([fact({ follow_up_at: 'nope' })], now), []);
});

Deno.test('selectDueFollowups boundary: due exactly now is included', () => {
  const now = new Date('2026-06-12T00:00:00Z');
  assertEquals(selectDueFollowups([fact({})], now).length, 1);
});

Deno.test('toFactDuePayload carries fact fields + day', () => {
  const p = toFactDuePayload(fact({}), '2026-06-12');
  assertEquals(p.fact_id, 'f1');
  assertEquals(p.text, 'du skal forny dit pas');
  assertEquals(p.day, '2026-06-12');
});
