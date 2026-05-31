// Deterministic, DST-aware free-slot finder.
//
// Pure module: no Date.now(), no `new Date()` with no args, no Math.random().
// All inputs arrive via `opts`/args so results are reproducible.
//
// Timezone math: we convert a local wall-clock (Y/M/D/H in `tz`) to a UTC
// instant by asking Intl what `tz` *shows* for a provisional UTC guess, then
// correcting by the observed offset. This is DST-correct because the offset is
// derived at the specific instant (CEST=+2 in June, CET=+1 in January).

export interface BusyInterval {
  start: string; // ISO
  end: string; // ISO
}

export interface FreeSlot {
  start_iso: string; // ISO (UTC, .toISOString())
  end_iso: string; // ISO (UTC, .toISOString())
}

export interface FreeSlotOpts {
  fromIso: string;
  toIso: string;
  tz: string;
  workdayStartHour: number; // local wall-clock hour
  workdayEndHour: number; // local wall-clock hour
  slotMinutes: number;
  maxSlots: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * Convert a wall-clock time in `tz` to its UTC instant (ms since epoch),
 * DST-correct. Reference impl from the task spec.
 */
function zonedTimeToUtcMs(
  y: number,
  mo: number, // 1-based month
  d: number,
  h: number,
  mi: number,
  tz: string,
): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(asUtc)).map((x) => [x.type, x.value]),
  );
  const seenUtc = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +p.hour % 24,
    +p.minute,
    +p.second,
  );
  return asUtc - (seenUtc - asUtc);
}

/** Short weekday name ("Mon", "Sat", ...) for a UTC instant, in `tz`. */
function weekdayInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(new Date(ms));
}

/** Calendar Y/M/D in `tz` for a UTC instant. */
function ymdInTz(
  ms: number,
  tz: string,
): { y: number; mo: number; d: number } {
  // en-CA renders YYYY-MM-DD.
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  const [y, mo, d] = s.split('-').map((x) => +x);
  return { y, mo, d };
}

export function computeFreeSlots(
  busy: BusyInterval[],
  opts: FreeSlotOpts,
): FreeSlot[] {
  const {
    fromIso,
    toIso,
    tz,
    workdayStartHour,
    workdayEndHour,
    slotMinutes,
    maxSlots,
  } = opts;

  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  const slotMs = slotMinutes * MS_PER_MINUTE;

  const busyMs = busy.map((b) => ({
    start: Date.parse(b.start),
    end: Date.parse(b.end),
  }));

  const slots: FreeSlot[] = [];
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    fromMs >= toMs ||
    maxSlots <= 0 ||
    slotMinutes <= 0 ||
    workdayEndHour <= workdayStartHour
  ) {
    return slots;
  }

  // Walk day by day. Re-derive the tz calendar date each iteration so DST
  // transitions and month/year rollovers are handled by Intl, not arithmetic.
  // We anchor each day off the wall-clock start hour (so we don't drift across
  // DST changes) and advance the probe by ~24h.
  let probeMs = fromMs;
  // Safety bound: at most one extra day past `toMs` worth of iterations.
  const maxDays = Math.ceil((toMs - fromMs) / MS_PER_DAY) + 2;

  for (let dayIdx = 0; dayIdx <= maxDays; dayIdx++) {
    if (probeMs > toMs) break;

    const { y, mo, d } = ymdInTz(probeMs, tz);

    // Determine UTC instant of this local day's workday start, then check the
    // weekday at that instant (robust to the probe landing near midnight).
    const dayStartMs = zonedTimeToUtcMs(y, mo, d, workdayStartHour, 0, tz);
    const wd = weekdayInTz(dayStartMs, tz);

    if (wd !== 'Sat' && wd !== 'Sun') {
      // Offer at most one slot per workday — the first free window that day.
      // (The agent surfaces ~maxSlots options spread across different days, not
      // a stack of back-to-back times on the same morning.)
      // Candidate slot starts step from workdayStartHour by slotMinutes while
      // start + slotMinutes <= workdayEndHour (wall-clock).
      const totalMin = (workdayEndHour - workdayStartHour) * 60;
      for (let offsetMin = 0; offsetMin + slotMinutes <= totalMin; offsetMin += slotMinutes) {
        const sMs = dayStartMs + offsetMin * MS_PER_MINUTE;
        const eMs = sMs + slotMs;

        // Within the requested window.
        if (sMs < fromMs || eMs > toMs) continue;

        // No overlap with any busy interval: s < b.end && e > b.start.
        const overlaps = busyMs.some((b) => sMs < b.end && eMs > b.start);
        if (overlaps) continue;

        slots.push({
          start_iso: new Date(sMs).toISOString(),
          end_iso: new Date(eMs).toISOString(),
        });
        if (slots.length >= maxSlots) return slots;
        break; // one slot per workday, then move to the next day
      }
    }

    // Advance to the next local day. Use the next day's midnight-ish probe by
    // adding 24h to the local day-start; small DST drift is fine because we
    // re-derive Y/M/D from the probe at the top of the loop.
    probeMs = dayStartMs + MS_PER_DAY;
  }

  return slots;
}
