// supabase/functions/_shared/agent/verify.test.ts
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildThreadAllowlist, verifyThreadId } from './verify.ts';

const sampleEvents = [
  { id: 1, kind: 'mail.new' as const, payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  { id: 2, kind: 'mail.new' as const, payload: { thread_id: 't2', message_id: 'm2', provider: 'google' } },
];

Deno.test('buildThreadAllowlist: pulls thread_ids from mail.new events', () => {
  assertEquals(buildThreadAllowlist(sampleEvents), new Set(['t1', 't2']));
});

Deno.test('verifyThreadId: passes when thread is in allowlist', () => {
  const allow = buildThreadAllowlist(sampleEvents);
  verifyThreadId('t1', allow); // no throw
});

Deno.test('verifyThreadId: throws when thread is hallucinated', () => {
  const allow = buildThreadAllowlist(sampleEvents);
  assertThrows(() => verifyThreadId('t-fake', allow), Error, 'unknown thread');
});
