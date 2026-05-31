import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeFreeSlots } from './free-slots.ts';

const base = {
  tz: 'Europe/Copenhagen',
  workdayStartHour: 9,
  workdayEndHour: 17,
  slotMinutes: 30,
  maxSlots: 3,
};

Deno.test('1. empty calendar → first slot each workday at 09:00 local (CEST = 07:00Z in June)', () => {
  const slots = computeFreeSlots([], {
    ...base,
    fromIso: '2026-06-01T05:00:00Z',
    toIso: '2026-06-03T20:00:00Z',
  });
  assertEquals(slots.length, 3);
  // 2026-06-01 is Monday; 09:00 CEST = 07:00Z
  assertEquals(slots[0].start_iso, '2026-06-01T07:00:00.000Z');
  // one per workday (Mon/Tue/Wed), all at 09:00 local
  assertEquals(slots[1].start_iso, '2026-06-02T07:00:00.000Z');
  assertEquals(slots[2].start_iso, '2026-06-03T07:00:00.000Z');
});

Deno.test('2. a busy block pushes the slot after it', () => {
  const slots = computeFreeSlots(
    [{ start: '2026-06-01T07:00:00Z', end: '2026-06-01T09:00:00Z' }], // 09–11 CPH
    {
      ...base,
      fromIso: '2026-06-01T05:00:00Z',
      toIso: '2026-06-01T20:00:00Z',
      maxSlots: 1,
    },
  );
  // next free slot starts 11:00 CPH = 09:00Z
  assertEquals(slots[0].start_iso, '2026-06-01T09:00:00.000Z');
});

Deno.test('3. fully-booked workday yields no slot that day', () => {
  const slots = computeFreeSlots(
    [{ start: '2026-06-01T07:00:00Z', end: '2026-06-01T15:00:00Z' }], // 09–17 CPH
    {
      ...base,
      fromIso: '2026-06-01T05:00:00Z',
      toIso: '2026-06-01T20:00:00Z',
    },
  );
  assertEquals(slots.length, 0);
});

Deno.test('4. skips weekends', () => {
  const slots = computeFreeSlots([], {
    ...base,
    fromIso: '2026-06-06T05:00:00Z', // Saturday
    toIso: '2026-06-08T20:00:00Z', // Monday
    maxSlots: 1,
  });
  assertEquals(slots[0].start_iso.startsWith('2026-06-08'), true);
});

Deno.test('5. respects slot duration (60-min)', () => {
  const slots = computeFreeSlots([], {
    ...base,
    fromIso: '2026-06-01T05:00:00Z',
    toIso: '2026-06-01T20:00:00Z',
    slotMinutes: 60,
    maxSlots: 1,
  });
  assertEquals(slots[0], {
    start_iso: '2026-06-01T07:00:00.000Z',
    end_iso: '2026-06-01T08:00:00.000Z',
  });
});

Deno.test('6a. a slot that would run past workday end is not emitted', () => {
  // Book 09:00–16:30 CPH (07:00Z–14:30Z). Only the 16:30–17:00 slot is free
  // for a 30-min slot. A 60-min slot would run 16:30–17:30, past 17:00, so none.
  const slots = computeFreeSlots(
    [{ start: '2026-06-01T07:00:00Z', end: '2026-06-01T14:30:00Z' }],
    {
      ...base,
      fromIso: '2026-06-01T05:00:00Z',
      toIso: '2026-06-01T20:00:00Z',
      slotMinutes: 60,
      maxSlots: 3,
    },
  );
  assertEquals(slots.length, 0);

  // Same booking, 30-min slot: exactly one slot 16:30–17:00 CPH = 14:30Z–15:00Z.
  const slots30 = computeFreeSlots(
    [{ start: '2026-06-01T07:00:00Z', end: '2026-06-01T14:30:00Z' }],
    {
      ...base,
      fromIso: '2026-06-01T05:00:00Z',
      toIso: '2026-06-01T20:00:00Z',
      slotMinutes: 30,
      maxSlots: 3,
    },
  );
  assertEquals(slots30.length, 1);
  assertEquals(slots30[0], {
    start_iso: '2026-06-01T14:30:00.000Z',
    end_iso: '2026-06-01T15:00:00.000Z',
  });
});

Deno.test('6b. DST-correctness: 09:00 CPH is 08:00Z in January (CET = UTC+1)', () => {
  // 2026-01-05 is a Monday. 09:00 CET = 08:00Z.
  const slots = computeFreeSlots([], {
    ...base,
    fromIso: '2026-01-05T05:00:00Z',
    toIso: '2026-01-05T20:00:00Z',
    maxSlots: 1,
  });
  assertEquals(slots[0].start_iso, '2026-01-05T08:00:00.000Z');
});
