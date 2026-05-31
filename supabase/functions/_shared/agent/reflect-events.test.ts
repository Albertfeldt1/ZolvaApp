import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { filterUpcomingEvents, type RawCalEvent } from './reflect-events.ts';

const now = new Date('2026-06-01T10:00:00Z');
const base: RawCalEvent = {
  event_id: 'e', provider: 'google', title: 'Møde', start: '2026-06-01T11:00:00Z', end: '2026-06-01T12:00:00Z',
  all_day: false, attendee_count: 2, response_status: 'accepted',
};

Deno.test('keeps an event starting within the 2h window', () => {
  assertEquals(filterUpcomingEvents([base], now, 120).length, 1);
});
Deno.test('drops an event starting after the window', () => {
  assertEquals(filterUpcomingEvents([{ ...base, start: '2026-06-01T13:00:00Z' }], now, 120).length, 0);
});
Deno.test('drops an event already started', () => {
  assertEquals(filterUpcomingEvents([{ ...base, start: '2026-06-01T09:00:00Z' }], now, 120).length, 0);
});
Deno.test('drops all-day events', () => {
  assertEquals(filterUpcomingEvents([{ ...base, all_day: true }], now, 120).length, 0);
});
Deno.test('drops solo events (no other attendees)', () => {
  assertEquals(filterUpcomingEvents([{ ...base, attendee_count: 1 }], now, 120).length, 0);
});
Deno.test('drops declined events', () => {
  assertEquals(filterUpcomingEvents([{ ...base, response_status: 'declined' }], now, 120).length, 0);
});
