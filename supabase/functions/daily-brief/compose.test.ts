import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { formatCalendarLines } from './compose.ts';
import type { BriefInputs } from './compose.ts';

function inputs(events: BriefInputs['events'], timezone = 'Europe/Copenhagen'): BriefInputs {
  return {
    kind: 'morning',
    name: null,
    timezone,
    events,
    unread: [],
    commitments: [],
    reminders: [],
    weather: null,
  };
}

Deno.test('formatCalendarLines: timed ranges (zone-aware ISO)', () => {
  const lines = formatCalendarLines(
    inputs([
      { title: 'Teammøde', startIso: '2026-05-15T09:00:00+02:00', endIso: '2026-05-15T10:00:00+02:00' },
      { title: 'Projektstatus – Q2', startIso: '2026-05-15T11:00:00+02:00', endIso: '2026-05-15T12:00:00+02:00' },
    ]),
  );
  assertEquals(lines, ['09:00–10:00 Teammøde', '11:00–12:00 Projektstatus – Q2']);
});

Deno.test('formatCalendarLines: all-day and location suffix', () => {
  const lines = formatCalendarLines(
    inputs([
      { title: 'Teamdag', startIso: '2026-05-15T00:00:00+02:00', endIso: '2026-05-16T00:00:00+02:00', allDay: true },
      { title: '1:1 med Mads', startIso: '2026-05-15T14:00:00+02:00', endIso: '2026-05-15T15:00:00+02:00', location: 'Mødelokale 4' },
    ]),
  );
  assertEquals(lines, ['Hele dagen · Teamdag', '14:00–15:00 1:1 med Mads · Mødelokale 4']);
});

Deno.test('formatCalendarLines: cross-midnight prefixes end weekday', () => {
  const lines = formatCalendarLines(
    inputs([
      { title: 'Vagt', startIso: '2026-05-15T16:00:00+02:00', endIso: '2026-05-16T00:30:00+02:00', location: 'Rox Resort' },
    ]),
  );
  assertEquals(lines, ['16:00–lørdag 00:30 Vagt · Rox Resort']);
});

Deno.test('formatCalendarLines: empty list', () => {
  assertEquals(formatCalendarLines(inputs([])), []);
});
