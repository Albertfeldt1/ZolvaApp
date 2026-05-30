// Start (Monday 00:00) and end (next Monday 00:00, exclusive) of the local
// calendar week containing `now`. Pure so the boundary math - easy to get wrong
// on Sundays, where getDay() is 0 - is unit-tested. Used to hand the chat model
// the exact "denne uge" range instead of letting it compute one (it queried
// only from today forward and missed earlier events in the week).
export function currentWeekBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun .. 6=Sat. Days since this week's Monday = (day + 6) % 7.
  start.setDate(start.getDate() - ((now.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}
