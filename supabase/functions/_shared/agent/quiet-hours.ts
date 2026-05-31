// supabase/functions/_shared/agent/quiet-hours.ts
//
// Pure quiet-hours check for agent nudges. No proactive push should fire during
// the user's local sleep window. agent-reflect gates the WHOLE run on this (not
// just the push send) so the calendar.upcoming dedup isn't consumed during quiet
// hours — the nudge then fires naturally at the first sweep after the window.

// Local sleep window: [22:00, 07:00). Start inclusive, end exclusive. The 07:00
// end means the earliest a prep nudge can fire is 07:00 local. Tunable.
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 7;

// The hour (0–23) of `now` in the given IANA timezone. Falls back to the UTC
// hour if the timezone is missing/invalid (fail-open: a bad tz shouldn't make
// us treat everything as quiet and silence the agent).
export function localHour(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    if (Number.isFinite(h)) return h;
  } catch {
    // invalid timezone — fall through to UTC
  }
  return now.getUTCHours();
}

export function isQuietHours(
  now: Date,
  timezone: string,
  startHour: number = QUIET_START_HOUR,
  endHour: number = QUIET_END_HOUR,
): boolean {
  const h = localHour(now, timezone);
  // Window wraps midnight: quiet when h >= start (late evening) OR h < end (early morning).
  return h >= startHour || h < endHour;
}
