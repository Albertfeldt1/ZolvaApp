import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveDue, selectDue } from './commitments.ts';
import type { CommitmentRow } from './commitments.ts';

function row(over: Partial<CommitmentRow>): CommitmentRow {
  return {
    id: 'c1', user_id: 'u1', direction: 'you_owe', counterparty: 'Allan',
    summary: 'Send Q3-decket', due_at: null, due_inferred: false,
    thread_id: 't1', provider: 'google', source_excerpt: '', last_message_at: null,
    status: 'open', created_at: '2026-06-01T08:00:00Z', nudged_at: null, resolved_at: null,
    ...over,
  };
}

Deno.test('resolveDue keeps an explicit due date and marks it not inferred', () => {
  const r = resolveDue('you_owe', '2026-06-05T09:00:00Z', '2026-06-01T10:00:00Z');
  assertEquals(r, { dueAt: '2026-06-05T09:00:00Z', inferred: false });
});

Deno.test('resolveDue infers +2 days for a you_owe promise from the anchor', () => {
  const r = resolveDue('you_owe', null, '2026-06-01T10:00:00Z');
  assertEquals(r, { dueAt: '2026-06-03T10:00:00.000Z', inferred: true });
});

Deno.test('resolveDue infers +3 days for owed_to_you from the anchor', () => {
  const r = resolveDue('owed_to_you', null, '2026-06-01T10:00:00Z');
  assertEquals(r, { dueAt: '2026-06-04T10:00:00.000Z', inferred: true });
});

Deno.test('resolveDue with no explicit date and no anchor yields null', () => {
  const r = resolveDue('you_owe', null, null);
  assertEquals(r, { dueAt: null, inferred: false });
});

Deno.test('selectDue picks a you_owe due within 24h not yet nudged today', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const r = row({ direction: 'you_owe', due_at: '2026-06-03T20:00:00Z' });
  assertEquals(selectDue([r], now).map((c) => c.id), ['c1']);
});

Deno.test('selectDue skips a you_owe due more than 24h out', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const r = row({ direction: 'you_owe', due_at: '2026-06-05T09:00:00Z' });
  assertEquals(selectDue([r], now), []);
});

Deno.test('selectDue skips a you_owe already nudged today (Copenhagen day)', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const r = row({ direction: 'you_owe', due_at: '2026-06-03T20:00:00Z', nudged_at: '2026-06-03T06:00:00Z' });
  assertEquals(selectDue([r], now), []);
});

Deno.test('selectDue picks an owed_to_you silent >3d and never nudged', () => {
  const now = new Date('2026-06-05T09:00:00Z');
  const r = row({ direction: 'owed_to_you', last_message_at: '2026-06-01T09:00:00Z', nudged_at: null });
  assertEquals(selectDue([r], now).map((c) => c.id), ['c1']);
});

Deno.test('selectDue nudges owed_to_you only once (nudged_at set => skip)', () => {
  const now = new Date('2026-06-05T09:00:00Z');
  const r = row({ direction: 'owed_to_you', last_message_at: '2026-06-01T09:00:00Z', nudged_at: '2026-06-04T09:00:00Z' });
  assertEquals(selectDue([r], now), []);
});

Deno.test('selectDue ignores non-open rows', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const r = row({ status: 'resolved', due_at: '2026-06-03T20:00:00Z' });
  assertEquals(selectDue([r], now), []);
});

import { applyReconcile } from './commitments.ts';

Deno.test('applyReconcile expires a you_owe past due_at + 7d with no movement', () => {
  const now = new Date('2026-06-15T09:00:00Z');
  const r = row({ direction: 'you_owe', due_at: '2026-06-03T09:00:00Z' });
  assertEquals(applyReconcile(r, { lastMessageAt: null, lastDirection: null }, now),
    { status: 'expired' });
});

Deno.test('applyReconcile resolves a you_owe when the user sent a newer message', () => {
  const now = new Date('2026-06-04T09:00:00Z');
  const r = row({ direction: 'you_owe', created_at: '2026-06-01T08:00:00Z', due_at: '2026-06-05T09:00:00Z' });
  assertEquals(
    applyReconcile(r, { lastMessageAt: '2026-06-03T12:00:00Z', lastDirection: 'outbound' }, now),
    { status: 'resolved', resolved_at: now.toISOString() },
  );
});

Deno.test('applyReconcile resolves an owed_to_you when an inbound reply arrives', () => {
  const now = new Date('2026-06-04T09:00:00Z');
  const r = row({ direction: 'owed_to_you', last_message_at: '2026-06-01T09:00:00Z' });
  assertEquals(
    applyReconcile(r, { lastMessageAt: '2026-06-03T10:00:00Z', lastDirection: 'inbound' }, now),
    { status: 'resolved', resolved_at: now.toISOString() },
  );
});

Deno.test('applyReconcile returns null when nothing changed', () => {
  const now = new Date('2026-06-04T09:00:00Z');
  const r = row({ direction: 'you_owe', created_at: '2026-06-01T08:00:00Z', due_at: '2026-06-10T09:00:00Z' });
  assertEquals(applyReconcile(r, { lastMessageAt: null, lastDirection: null }, now), null);
});
