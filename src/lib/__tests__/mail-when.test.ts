// src/lib/__tests__/mail-when.test.ts
// Dates are built with local-time components and compared with local getters,
// so these assertions hold regardless of the machine timezone Jest runs in.
import { formatMailWhen } from '../mail-when';

// "now" = 30 May 2026, 13:00 local.
const now = new Date(2026, 4, 30, 13, 0, 0);

describe('formatMailWhen', () => {
  it('labels same-day mail as "i dag" with local time', () => {
    expect(formatMailWhen(new Date(2026, 4, 30, 13, 14), now)).toBe('i dag kl. 13.14');
  });

  it('labels previous-day mail as "i går" (the bug: was rendered "i dag")', () => {
    // 29 May 17:24 - the "Apple iPhone login" alert that showed as "i dag".
    expect(formatMailWhen(new Date(2026, 4, 29, 17, 24), now)).toBe('i går kl. 17.24');
  });

  it('uses an early-morning previous-day time without flipping the day', () => {
    expect(formatMailWhen(new Date(2026, 4, 29, 9, 46), now)).toBe('i går kl. 09.46');
  });

  it('labels older same-year mail with a Danish month and no year', () => {
    expect(formatMailWhen(new Date(2026, 4, 27, 22, 10), now)).toBe('27. maj kl. 22.10');
  });

  it('includes the year only when it differs from now', () => {
    expect(formatMailWhen(new Date(2025, 11, 31, 8, 5), now)).toBe('31. dec. 2025 kl. 08.05');
  });
});
