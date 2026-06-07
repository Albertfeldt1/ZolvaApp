import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { chatLimitForTier } from './chat-limits.ts';

Deno.test('free is capped at 50/week', () => {
  assertEquals(chatLimitForTier('free'), 50);
});
Deno.test('lite is capped at 300/week', () => {
  assertEquals(chatLimitForTier('lite'), 300);
});
Deno.test('pro is unlimited (null)', () => {
  assertEquals(chatLimitForTier('pro'), null);
});
