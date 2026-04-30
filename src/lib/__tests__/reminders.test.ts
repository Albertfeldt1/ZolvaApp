// Mock supabase + AsyncStorage before any module that imports them to avoid
// native-module errors. Pure helpers under test never call either.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));

import { isPendingAndDueOrUpcoming, formatReminderForListTool } from '../reminders';
import type { Reminder } from '../types';

const baseReminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  text: 'pick up dry cleaning',
  dueAt: new Date('2026-05-01T16:00:00Z'),
  status: 'pending',
  createdAt: new Date('2026-04-30T10:00:00Z'),
  doneAt: null,
  firedAt: null,
  scheduledForTz: null,
  ...over,
});

describe('isPendingAndDueOrUpcoming', () => {
  const NOW = new Date('2026-05-01T15:00:00Z');

  it('keeps future-due pending reminders', () => {
    expect(isPendingAndDueOrUpcoming(baseReminder(), NOW)).toBe(true);
  });

  it('keeps no-time pending reminders', () => {
    expect(isPendingAndDueOrUpcoming(baseReminder({ dueAt: null }), NOW)).toBe(true);
  });

  it('keeps recently-past pending reminders inside grace window', () => {
    const r = baseReminder({ dueAt: new Date('2026-05-01T14:58:00Z') });
    expect(isPendingAndDueOrUpcoming(r, NOW)).toBe(true);
  });

  it('drops reminders past the 5-min grace window', () => {
    const r = baseReminder({ dueAt: new Date('2026-05-01T14:50:00Z') });
    expect(isPendingAndDueOrUpcoming(r, NOW)).toBe(false);
  });

  it('drops completed reminders regardless of due time', () => {
    const r = baseReminder({ status: 'done', doneAt: NOW });
    expect(isPendingAndDueOrUpcoming(r, NOW)).toBe(false);
  });
});

describe('formatReminderForListTool', () => {
  it('renders id, status, due, text', () => {
    const out = formatReminderForListTool(baseReminder());
    expect(out).toBe('r1 [pending] 2026-05-01T16:00:00.000Z: pick up dry cleaning');
  });

  it('renders ingen tid for null dueAt', () => {
    const out = formatReminderForListTool(baseReminder({ dueAt: null }));
    expect(out).toBe('r1 [pending] ingen tid: pick up dry cleaning');
  });
});
