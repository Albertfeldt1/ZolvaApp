// All-day calendar events are addressed by a calendar DATE, not an instant.
// The Date we receive (from parseDate on an ISO string with a timezone offset)
// represents local midnight of the user's intended day, so we must read its
// LOCAL components. Reading UTC components shifts the day backward for every
// user east of UTC (e.g. all Danish users at UTC+1/+2), landing the event one
// day early. See google-calendar.ts / icloud-calendar.ts callers.

function localDateParts(d: Date): { yyyy: string; mm: string; dd: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    yyyy: String(d.getFullYear()),
    mm: pad(d.getMonth() + 1),
    dd: pad(d.getDate()),
  };
}

// Google Calendar all-day date: "2026-06-15"
export function allDayDateHyphenated(d: Date): string {
  const { yyyy, mm, dd } = localDateParts(d);
  return `${yyyy}-${mm}-${dd}`;
}

// iCloud / iCalendar DATE value: "20260615"
export function allDayDateCompact(d: Date): string {
  const { yyyy, mm, dd } = localDateParts(d);
  return `${yyyy}${mm}${dd}`;
}
