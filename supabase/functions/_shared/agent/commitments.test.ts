import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyReconcile, buildCommitmentNudge, resolveDue, selectDue } from './commitments.ts';
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

Deno.test('selectDue picks an aged you_owe due within the lead window, not yet nudged today', () => {
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

Deno.test('buildCommitmentNudge for you_owe names the counterparty and summary', () => {
  const n = buildCommitmentNudge(row({ direction: 'you_owe', counterparty: 'Allan', summary: 'send Q3-decket' }));
  assertEquals(n.action_kind, 'commitment');
  assertEquals(n.target_id, 't1');
  assertEquals(n.body.includes('Allan'), true);
  assertEquals(n.body.includes('send Q3-decket'), true);
});

Deno.test('buildCommitmentNudge for owed_to_you phrases it as waiting', () => {
  const n = buildCommitmentNudge(row({ direction: 'owed_to_you', counterparty: 'Mette', summary: 'svar om mødet' }));
  assertEquals(n.body.toLowerCase().includes('venter'), true);
  assertEquals(n.body.includes('Mette'), true);
});

Deno.test('buildCommitmentNudge clamps body to 140 chars', () => {
  const n = buildCommitmentNudge(row({ summary: 'x'.repeat(300) }));
  assertEquals(n.body.length <= 140, true);
});

Deno.test('selectDue you_owe boundary: due exactly now+12h included, +1ms excluded', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const at = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const past = new Date(now.getTime() + 12 * 60 * 60 * 1000 + 1).toISOString();
  assertEquals(selectDue([row({ direction: 'you_owe', due_at: at })], now).length, 1);
  assertEquals(selectDue([row({ direction: 'you_owe', due_at: past })], now).length, 0);
});

Deno.test('selectDue does NOT nudge a fresh you_owe even when due is near (min-age floor)', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  // Promise made 1h ago, due in 3h — deadline is near, but you just said it.
  const r = row({
    direction: 'you_owe',
    created_at: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
    due_at: new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString(),
  });
  assertEquals(selectDue([r], now), []);
});

Deno.test('selectDue nudges an aged you_owe with a near deadline', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  // Promise made 5h ago (past the 4h floor), due in 3h.
  const r = row({
    direction: 'you_owe',
    created_at: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(),
    due_at: new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString(),
  });
  assertEquals(selectDue([r], now).map((c) => c.id), ['c1']);
});

Deno.test('selectDue you_owe min-age boundary: created exactly 4h ago included, just under excluded', () => {
  const now = new Date('2026-06-03T09:00:00Z');
  const dueSoon = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const aged = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();        // exactly 4h old → included
  const tooFresh = new Date(now.getTime() - 4 * 60 * 60 * 1000 + 1).toISOString(); // 4h minus 1ms → excluded
  assertEquals(selectDue([row({ direction: 'you_owe', created_at: aged, due_at: dueSoon })], now).length, 1);
  assertEquals(selectDue([row({ direction: 'you_owe', created_at: tooFresh, due_at: dueSoon })], now).length, 0);
});

Deno.test('selectDue owed_to_you boundary: silent exactly 3d included, under 3d excluded', () => {
  const now = new Date('2026-06-05T09:00:00Z');
  const at = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const under = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000 + 1).toISOString();
  assertEquals(selectDue([row({ direction: 'owed_to_you', last_message_at: at })], now).length, 1);
  assertEquals(selectDue([row({ direction: 'owed_to_you', last_message_at: under })], now).length, 0);
});
