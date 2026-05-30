// Formats a mail's received time for the chat tool output. The tool used to
// emit a raw UTC ISO string and rely on the model to convert timezone AND work
// out "i dag"/"i går" - which it got wrong (yesterday's mail rendered as "i
// dag", times off by the UTC offset). Date math is exactly what an LLM should
// not be doing, so we pre-compute a Danish, local-time label here and hand the
// model a value it only has to echo.

const DA_MONTHS = [
  'jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.',
  'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.',
];

// Whole-calendar-day delta between two Dates in local time (ignores clock time).
function calendarDayDiff(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// e.g. "i dag kl. 17.24", "i går kl. 09.46", "27. maj kl. 22.10".
// Danish writes clock time with a period separator and the "kl." prefix.
export function formatMailWhen(received: Date, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `kl. ${pad(received.getHours())}.${pad(received.getMinutes())}`;
  const daysAgo = calendarDayDiff(received, now);
  if (daysAgo === 0) return `i dag ${time}`;
  if (daysAgo === 1) return `i går ${time}`;
  const day = `${received.getDate()}. ${DA_MONTHS[received.getMonth()]}`;
  // Include the year only when it differs from now, to keep the common case terse.
  const year = received.getFullYear() === now.getFullYear() ? '' : ` ${received.getFullYear()}`;
  return `${day}${year} ${time}`;
}
