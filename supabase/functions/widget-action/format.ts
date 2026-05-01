const DA_HOURS = [
  'nul', 'et', 'to', 'tre', 'fire', 'fem', 'seks', 'syv',
  'otte', 'ni', 'ti', 'elleve', 'tolv', 'tretten', 'fjorten',
  'femten', 'seksten', 'sytten', 'atten', 'nitten', 'tyve',
  'enogtyve', 'toogtyve', 'treogtyve',
];
const EN_HOURS = [
  'twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven',
];
const DA_MONTHS = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december',
];
const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type NaturalTimeArgs = {
  eventIso: string;
  nowIso: string;
  locale: 'da' | 'en';
  timezone: string;
};

export function naturalTime(args: NaturalTimeArgs): string {
  const event = new Date(args.eventIso);
  const now = new Date(args.nowIso);

  // Project both into the user's timezone for day-difference computation.
  const partsAt = (d: Date) => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: args.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>;
    return parts;
  };
  const eP = partsAt(event);
  const nP = partsAt(now);

  const eventMidnight = Date.UTC(+eP.year, +eP.month - 1, +eP.day);
  const nowMidnight = Date.UTC(+nP.year, +nP.month - 1, +nP.day);
  const dayDelta = Math.round((eventMidnight - nowMidnight) / (24 * 60 * 60 * 1000));

  const hour24 = parseInt(eP.hour, 10);
  const minute = parseInt(eP.minute, 10);

  if (dayDelta >= 0 && dayDelta <= 7) {
    return relativeWithin7Days(dayDelta, hour24, minute, args.locale);
  }
  return absoluteSpelled(eP, hour24, minute, args.locale);
}

function relativeWithin7Days(
  dayDelta: number,
  hour24: number,
  minute: number,
  locale: 'da' | 'en',
): string {
  if (locale === 'da') {
    const daySegment = dayDelta === 0 ? 'i dag' : dayDelta === 1 ? 'i morgen' : `om ${dayDelta} dage`;
    const hourWord = DA_HOURS[hour24] ?? String(hour24);
    const min = minute > 0 ? ` ${minute}` : '';
    return `${daySegment} kl. ${hourWord}${min}`;
  }
  const daySegment = dayDelta === 0 ? 'today' : dayDelta === 1 ? 'tomorrow' : `in ${dayDelta} days`;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const h12 = hour24 % 12;
  const hourWord = EN_HOURS[h12] ?? String(h12);
  const min = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  return `${daySegment} at ${hourWord}${min} ${meridiem}`;
}

function absoluteSpelled(
  parts: Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>,
  hour24: number,
  minute: number,
  locale: 'da' | 'en',
): string {
  const month = parseInt(parts.month, 10) - 1;
  const day = parseInt(parts.day, 10);
  if (locale === 'da') {
    const hourWord = DA_HOURS[hour24] ?? String(hour24);
    const min = minute > 0 ? ` ${minute}` : '';
    return `den ${day}. ${DA_MONTHS[month]} kl. ${hourWord}${min}`;
  }
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const h12 = hour24 % 12;
  const hourWord = EN_HOURS[h12] ?? String(h12);
  const min = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  return `${EN_MONTHS[month]} ${day} at ${hourWord}${min} ${meridiem}`;
}

const ELLIPSIS = '…';

export function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  // Reserve one slot for the ellipsis.
  const cap = limit - 1;
  const slice = s.slice(0, cap);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= 1) return slice.slice(0, lastSpace) + ELLIPSIS;
  // No whitespace before the limit (very long compound word) — hard cut.
  return slice + ELLIPSIS;
}
