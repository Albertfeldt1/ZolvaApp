import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isQuietHours, localHour } from './quiet-hours.ts';

// Copenhagen is UTC+2 in June (CEST).
Deno.test('localHour converts a UTC instant to the timezone-local hour', () => {
  assertEquals(localHour(new Date('2026-06-01T05:00:00Z'), 'Europe/Copenhagen'), 7);
  assertEquals(localHour(new Date('2026-06-01T20:30:00Z'), 'Europe/Copenhagen'), 22);
});

Deno.test('localHour falls back to UTC hour on an invalid timezone', () => {
  assertEquals(localHour(new Date('2026-06-01T05:00:00Z'), 'Not/AZone'), 5);
});

Deno.test('isQuietHours: 22:00–07:00 local is quiet (wraps midnight)', () => {
  // 22:30 local → quiet
  assertEquals(isQuietHours(new Date('2026-06-01T20:30:00Z'), 'Europe/Copenhagen'), true);
  // 03:00 local → quiet
  assertEquals(isQuietHours(new Date('2026-06-01T01:00:00Z'), 'Europe/Copenhagen'), true);
  // 06:00 local → quiet
  assertEquals(isQuietHours(new Date('2026-06-01T04:00:00Z'), 'Europe/Copenhagen'), true);
});

Deno.test('isQuietHours: 07:00 local is NOT quiet (window end is exclusive)', () => {
  assertEquals(isQuietHours(new Date('2026-06-01T05:00:00Z'), 'Europe/Copenhagen'), false);
});

Deno.test('isQuietHours: daytime/evening before 22:00 is NOT quiet', () => {
  // 12:00 local
  assertEquals(isQuietHours(new Date('2026-06-01T10:00:00Z'), 'Europe/Copenhagen'), false);
  // 21:59-ish → 21:00 hour → not quiet
  assertEquals(isQuietHours(new Date('2026-06-01T19:00:00Z'), 'Europe/Copenhagen'), false);
});

Deno.test('isQuietHours: 22:00 local exactly IS quiet (window start inclusive)', () => {
  assertEquals(isQuietHours(new Date('2026-06-01T20:00:00Z'), 'Europe/Copenhagen'), true);
});
