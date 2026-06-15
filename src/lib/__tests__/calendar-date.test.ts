// Pin a UTC+ timezone so the regression is deterministic regardless of the
// machine running the suite. The bug only manifests east of UTC, where a
// local-midnight Date's UTC date is the *previous* calendar day.
process.env.TZ = 'Europe/Copenhagen';

import { allDayDateHyphenated, allDayDateCompact } from '../calendar-date';

describe('all-day calendar date formatting', () => {
  test('uses the local calendar day, not UTC (no -1 shift for UTC+ users)', () => {
    // Local midnight of 15 June 2026 — what parseDate produces for an
    // all-day event the user means to land on the 15th.
    const localMidnight = new Date(2026, 5, 15, 0, 0, 0);
    expect(allDayDateHyphenated(localMidnight)).toBe('2026-06-15');
    expect(allDayDateCompact(localMidnight)).toBe('20260615');
  });

  test('zero-pads single-digit month and day', () => {
    const d = new Date(2026, 0, 3, 0, 0, 0); // 3 Jan 2026
    expect(allDayDateHyphenated(d)).toBe('2026-01-03');
    expect(allDayDateCompact(d)).toBe('20260103');
  });
});
