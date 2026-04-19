// Fetches today's calendar events from whichever providers are connected,
// normalizes them, and filters down to ones eligible for a 15-minute
// pre-alert. Returns an empty array on any fetch failure (best-effort).

import {
  hasOtherAttendees as googleHasOtherAttendees,
  isAllDay as googleIsAllDay,
  listEvents as listGoogleEvents,
  userAccepted as googleUserAccepted,
  eventStart as googleEventStart,
  type GoogleCalendarEvent,
} from './google-calendar';
import {
  listCalendarEvents as listGraphEvents,
  type GraphCalendarEvent,
} from './microsoft-graph';

export type CalendarEventForAlert = {
  id: string;
  title: string;
  start: Date;
  source: 'google' | 'microsoft';
};

function endOfToday(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

function passesGoogleFilter(e: GoogleCalendarEvent, now: Date): CalendarEventForAlert | null {
  const start = googleEventStart(e);
  if (!start) return null;
  if (googleIsAllDay(e)) return null;
  if (start.getTime() <= now.getTime() + 15 * 60 * 1000) return null;
  if (!googleHasOtherAttendees(e)) return null;
  if (!googleUserAccepted(e)) return null;
  return {
    id: `google:${e.id}`,
    title: e.summary ?? 'Uden titel',
    start,
    source: 'google',
  };
}

function passesGraphFilter(e: GraphCalendarEvent, now: Date): CalendarEventForAlert | null {
  if (e.isAllDay) return null;
  if (e.start.getTime() <= now.getTime() + 15 * 60 * 1000) return null;
  if (!e.hasOtherAttendees) return null;
  if (e.userResponse !== 'accepted' && e.userResponse !== 'organizer') return null;
  return {
    id: `microsoft:${e.id}`,
    title: e.subject,
    start: e.start,
    source: 'microsoft',
  };
}

export async function fetchPreAlertEligibleEvents(): Promise<CalendarEventForAlert[]> {
  const now = new Date();
  const end = endOfToday(now);
  const results: CalendarEventForAlert[] = [];

  const google = await listGoogleEvents(now, end).catch((err) => {
    if (__DEV__) console.warn('[calendar-events-today] google fetch failed:', err);
    return [] as GoogleCalendarEvent[];
  });
  for (const e of google) {
    const passed = passesGoogleFilter(e, now);
    if (passed) results.push(passed);
  }

  const graph = await listGraphEvents(now, end).catch((err) => {
    if (__DEV__) console.warn('[calendar-events-today] graph fetch failed:', err);
    return [] as GraphCalendarEvent[];
  });
  for (const e of graph) {
    const passed = passesGraphFilter(e, now);
    if (passed) results.push(passed);
  }

  return results;
}
