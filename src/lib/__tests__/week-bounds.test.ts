// src/lib/__tests__/week-bounds.test.ts
// Dates built and compared with local components, so assertions are TZ-stable.
// May 2026: 25th is a Monday, 30th a Saturday, 31st a Sunday, Jun 1 a Monday.
import { currentWeekBounds } from '../week-bounds';

const expectYMD = (d: Date, y: number, m: number, day: number) => {
  expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([y, m, day, 0]);
};

describe('currentWeekBounds', () => {
  it('Saturday resolves to Mon..next-Mon (the reported case)', () => {
    const { start, end } = currentWeekBounds(new Date(2026, 4, 30, 14, 12)); // Sat 30 May
    expectYMD(start, 2026, 4, 25); // Mon 25 May 00:00
    expectYMD(end, 2026, 5, 1); // Mon 1 Jun 00:00 (exclusive)
  });

  it('Sunday belongs to the week that started the previous Monday', () => {
    const { start, end } = currentWeekBounds(new Date(2026, 4, 31, 9, 0)); // Sun 31 May
    expectYMD(start, 2026, 4, 25);
    expectYMD(end, 2026, 5, 1);
  });

  it('Monday resolves to itself at 00:00', () => {
    const { start, end } = currentWeekBounds(new Date(2026, 4, 25, 23, 59)); // Mon 25 May
    expectYMD(start, 2026, 4, 25);
    expectYMD(end, 2026, 5, 1);
  });
});
