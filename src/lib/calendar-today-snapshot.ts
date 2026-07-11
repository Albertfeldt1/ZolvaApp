// In-memory snapshot of today's calendar events, populated as a side effect
// of the calendar fetches that already run (useCalendarItems in hooks.ts).
// Lets consumers without their own calendar fetch (chat suggestion chips,
// the chat memory preamble) read "what's on today" synchronously without
// adding a new network path. Best-effort by design: empty until some
// calendar consumer has fetched today, and empty again past midnight until
// the next fetch lands.

import { subscribeUserId } from './auth';

export type TodayCalendarEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
};

let snapshot: TodayCalendarEvent[] = [];
let snapshotDayKey: string | null = null;

const listeners = new Set<() => void>();

// Never leak one account's calendar into another's chat context.
subscribeUserId(() => {
  snapshot = [];
  snapshotDayKey = null;
  listeners.forEach((l) => l());
});

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Record today's events (caller filters to the local day). Overwrites. */
export function noteTodayCalendarEvents(events: TodayCalendarEvent[], now: Date = new Date()): void {
  snapshot = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
  snapshotDayKey = dayKeyOf(now);
  listeners.forEach((l) => l());
}

/** Today's events, or [] when nothing has been fetched yet — or the snapshot
 * is from a previous day (stale context is worse than no context). */
export function getTodayCalendarEvents(now: Date = new Date()): TodayCalendarEvent[] {
  if (snapshotDayKey !== dayKeyOf(now)) return [];
  return snapshot;
}

/** Wake a consumer when the snapshot changes (fetch landed / user switched). */
export function subscribeTodayCalendarEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
