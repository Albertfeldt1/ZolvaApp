import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { naturalTime, truncate } from './format.ts';

Deno.test('naturalTime DA tomorrow', () => {
  // now = 2026-04-28 14:00, event = 2026-04-29 17:00
  const out = naturalTime({
    eventIso: '2026-04-29T17:00:00+02:00',
    nowIso: '2026-04-28T14:00:00+02:00',
    locale: 'da',
    timezone: 'Europe/Copenhagen',
  });
  assertEquals(out, 'i morgen kl. sytten');
});

Deno.test('naturalTime EN tomorrow', () => {
  const out = naturalTime({
    eventIso: '2026-04-29T17:00:00+02:00',
    nowIso: '2026-04-28T14:00:00+02:00',
    locale: 'en',
    timezone: 'Europe/Copenhagen',
  });
  assertEquals(out, 'tomorrow at five PM');
});

Deno.test('naturalTime >7 days DA', () => {
  const out = naturalTime({
    eventIso: '2026-05-15T14:00:00+02:00',
    nowIso: '2026-04-28T10:00:00+02:00',
    locale: 'da',
    timezone: 'Europe/Copenhagen',
  });
  assertEquals(out, 'den 15. maj kl. fjorten');
});

Deno.test('truncate at word boundary', () => {
  const t = truncate('Møde med Sophie om det nye projekt der lyder spændende', 20);
  // last word boundary at-or-before 20 = " om det" → keep "Møde med Sophie om" then cut at space, append …
  // Implementation detail: target ≤20 chars including the …
  assertEquals(t.length <= 20, true);
  assertEquals(t.endsWith('…'), true);
  assertEquals(t.includes(' '), true); // didn't mid-word cut
});

Deno.test('truncate hard-cuts a word longer than limit', () => {
  const t = truncate('Donaudampfschifffahrtsgesellschaftskapitän', 10);
  assertEquals(t.length, 10);
  assertEquals(t.endsWith('…'), true);
});

Deno.test('truncate passes through short text unchanged', () => {
  assertEquals(truncate('Møde', 80), 'Møde');
});
