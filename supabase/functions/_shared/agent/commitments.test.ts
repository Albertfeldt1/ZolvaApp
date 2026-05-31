import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveDue } from './commitments.ts';

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
