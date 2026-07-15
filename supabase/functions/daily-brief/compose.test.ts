import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { formatCalendarLines, selectRelevantEvents } from './compose.ts';
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

const tz = 'Europe/Copenhagen';
// 2026-07-15 19:00 local (+02:00) = 17:00Z. The real bug: evening brief at 19.
const evening = new Date('2026-07-15T17:00:00Z');

Deno.test('selectRelevantEvents: drops an event that ended before now (the 17:00 bug)', () => {
  const events = [
    { title: 'Køber kommer', startIso: '2026-07-15T17:00:00+02:00', endIso: '2026-07-15T17:30:00+02:00' },
  ];
  assertEquals(selectRelevantEvents(events, tz, evening), []);
});

Deno.test('selectRelevantEvents: keeps an upcoming event', () => {
  const events = [
    { title: 'Aftensmad ude', startIso: '2026-07-15T20:00:00+02:00', endIso: '2026-07-15T22:00:00+02:00' },
  ];
  assertEquals(selectRelevantEvents(events, tz, evening).length, 1);
});

Deno.test('selectRelevantEvents: keeps an event in progress right now', () => {
  const events = [
    { title: 'Lang vagt', startIso: '2026-07-15T16:00:00+02:00', endIso: '2026-07-15T20:00:00+02:00' },
  ];
  assertEquals(selectRelevantEvents(events, tz, evening).length, 1);
});

Deno.test('selectRelevantEvents: keeps all-day and cross-midnight events', () => {
  const events = [
    { title: 'Ferie', startIso: '2026-07-15T00:00:00+02:00', endIso: '2026-07-16T00:00:00+02:00', allDay: true },
    { title: 'Nattevagt', startIso: '2026-07-15T22:00:00+02:00', endIso: '2026-07-16T06:00:00+02:00' },
  ];
  assertEquals(selectRelevantEvents(events, tz, evening).length, 2);
});

Deno.test('selectRelevantEvents: mixed day keeps only what has not ended', () => {
  const events = [
    { title: 'Morgenmøde', startIso: '2026-07-15T09:00:00+02:00', endIso: '2026-07-15T10:00:00+02:00' },
    { title: 'Køber kommer', startIso: '2026-07-15T17:00:00+02:00', endIso: '2026-07-15T17:30:00+02:00' },
    { title: 'Middag', startIso: '2026-07-15T20:00:00+02:00', endIso: '2026-07-15T22:00:00+02:00' },
  ];
  assertEquals(
    selectRelevantEvents(events, tz, evening).map((e) => e.title),
    ['Middag'],
  );
});

Deno.test('selectRelevantEvents: naive ISO (Microsoft Graph, no zone) compares correctly', () => {
  // Naive local time — same wall clock as the +02:00 cases above.
  const events = [
    { title: 'Køber kommer', startIso: '2026-07-15T17:00:00', endIso: '2026-07-15T17:30:00' },
    { title: 'Middag', startIso: '2026-07-15T20:00:00', endIso: '2026-07-15T22:00:00' },
  ];
  assertEquals(
    selectRelevantEvents(events, tz, evening).map((e) => e.title),
    ['Middag'],
  );
});

Deno.test('selectRelevantEvents: morning brief keeps the full day', () => {
  const morning = new Date('2026-07-15T05:00:00Z'); // 07:00 local
  const events = [
    { title: 'Morgenmøde', startIso: '2026-07-15T09:00:00+02:00', endIso: '2026-07-15T10:00:00+02:00' },
    { title: 'Køber kommer', startIso: '2026-07-15T17:00:00+02:00', endIso: '2026-07-15T17:30:00+02:00' },
  ];
  assertEquals(selectRelevantEvents(events, tz, morning).length, 2);
});
