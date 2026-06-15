// Mock the native modules icloud-calendar pulls in at import time; the parser
// under test touches none of them.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('../secure-storage', () => ({}));
jest.mock('../icloud-credentials', () => ({ loadCredential: jest.fn(), markInvalid: jest.fn() }));

import { parseVcalendarEvents } from '../icloud-calendar';

const CAL = { url: 'https://caldav.icloud.com/cal', displayName: 'Privat', calendarColor: '#fff' };

// A daily standup (3 occurrences) with the middle instance moved to a new time
// via a RECURRENCE-ID override.
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1',
  'DTSTART:20260615T090000Z',
  'DTEND:20260615T100000Z',
  'RRULE:FREQ=DAILY;COUNT=3',
  'SUMMARY:Standup',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-1',
  'RECURRENCE-ID:20260616T090000Z',
  'DTSTART:20260616T140000Z',
  'DTEND:20260616T150000Z',
  'SUMMARY:Standup (flyttet)',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseVcalendarEvents recurrence overrides', () => {
  test('a moved instance replaces its occurrence instead of duplicating it', () => {
    const events = parseVcalendarEvents(
      ICS,
      new Date('2026-06-15T00:00:00Z'),
      new Date('2026-06-18T00:00:00Z'),
      CAL,
      'https://caldav.icloud.com/cal/evt-1.ics',
    );
    // 3 occurrences, not 4 — the 16th appears once, at the moved time.
    expect(events.length).toBe(3);
    const onThe16th = events.filter((e) => e.start.toISOString().startsWith('2026-06-16'));
    expect(onThe16th).toHaveLength(1);
    expect(onThe16th[0].start.toISOString()).toBe('2026-06-16T14:00:00.000Z');
    expect(onThe16th[0].title).toBe('Standup (flyttet)');
  });
});
