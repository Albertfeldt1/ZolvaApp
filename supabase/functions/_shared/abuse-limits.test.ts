import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { dailyRequestCapForTier, RPM_LIMIT } from './abuse-limits.ts';

Deno.test('free gets the tighter daily cap', () => {
  assertEquals(dailyRequestCapForTier('free'), 250);
});

Deno.test('paid tiers keep the higher daily cap', () => {
  assertEquals(dailyRequestCapForTier('lite'), 500);
  assertEquals(dailyRequestCapForTier('pro'), 500);
});

Deno.test('RPM cap is shared across tiers', () => {
  assertEquals(RPM_LIMIT, 60);
});
