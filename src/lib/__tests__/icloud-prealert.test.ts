// calendar-events-today imports the provider clients (which pull in native
// modules); mock them so the pure filter under test can import cleanly.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('../google-calendar', () => ({}));
jest.mock('../microsoft-graph', () => ({}));
jest.mock('../icloud-calendar', () => ({}));
jest.mock('../integration-flags', () => ({ getIntegrationFlag: jest.fn(), loadIntegrationFlags: jest.fn() }));
jest.mock('../auth', () => ({ getActiveUserId: jest.fn() }));

import { passesIcloudFilter } from '../calendar-events-today';

const base = {
  uid: 'evt-1',
  eventUrl: 'https://x/evt-1.ics',
  allDay: false,
  title: 'Sync',
  attendeeCount: 2,
  calendarName: 'Arbejde',
  calendarUrl: 'https://x',
};
const now = new Date('2026-06-16T09:00:00Z');
const inOneHour = new Date('2026-06-16T10:00:00Z');

describe('passesIcloudFilter', () => {
  test('passes a timed meeting (>15 min out) that has attendees', () => {
    const r = passesIcloudFilter({ ...base, start: inOneHour, end: new Date('2026-06-16T11:00:00Z') }, now);
    expect(r).toEqual({ id: 'icloud:evt-1', title: 'Sync', start: inOneHour, source: 'icloud' });
  });

  test('skips all-day events', () => {
    expect(passesIcloudFilter({ ...base, allDay: true, start: inOneHour, end: inOneHour }, now)).toBeNull();
  });

  test('skips events starting within 15 minutes (or in the past)', () => {
    const soon = new Date('2026-06-16T09:10:00Z');
    expect(passesIcloudFilter({ ...base, start: soon, end: soon }, now)).toBeNull();
  });

  test('skips personal blocks with no attendees', () => {
    expect(passesIcloudFilter({ ...base, attendeeCount: 0, start: inOneHour, end: inOneHour }, now)).toBeNull();
  });
});
