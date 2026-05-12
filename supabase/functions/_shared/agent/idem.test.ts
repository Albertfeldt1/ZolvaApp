// supabase/functions/_shared/agent/idem.test.ts
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deriveIdemKey } from './idem.ts';

Deno.test('mail.label idem key includes thread_id, label, op', () => {
  assertEquals(
    deriveIdemKey('mail.label', { thread_id: 't1', label: 'Receipts', op: 'add' }),
    'mail.label:t1:Receipts:add',
  );
});

Deno.test('mail.archive idem key uses thread_id', () => {
  assertEquals(
    deriveIdemKey('mail.archive', { thread_id: 't1' }),
    'mail.archive:t1',
  );
});

Deno.test('mail.summarize idem key uses thread_id', () => {
  assertEquals(
    deriveIdemKey('mail.summarize', { thread_id: 't1' }),
    'mail.summarize:t1',
  );
});

Deno.test('mail.flag_important idem key uses thread_id', () => {
  assertEquals(
    deriveIdemKey('mail.flag_important', { thread_id: 't1' }),
    'mail.flag_important:t1',
  );
});

Deno.test('deriveIdemKey throws on missing required field', () => {
  assertThrows(() => deriveIdemKey('mail.archive', {} as never), Error, 'thread_id');
});
