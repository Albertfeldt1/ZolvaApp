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
  listCalendarEventsForCalendars as listGraphEventsWithCalendarId,
  type GraphCalendarEvent,
} from './microsoft-graph';
import { listEvents as listIcloudEvents, type IcloudCalEvent } from './icloud-calendar';
import { getActiveUserId } from './auth';
import { getIntegrationFlag, loadIntegrationFlags } from './integration-flags';
import { loadCalendarVisibility, isCalendarVisible } from './calendar-visibility';

export type CalendarEventForAlert = {
  id: string;
  title: string;
  start: Date;
  source: 'google' | 'microsoft' | 'icloud';
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

// iCloud exposes no RSVP/PARTSTAT, so we can't filter to "meetings you
// accepted" like Google/Outlook. Gate on attendee presence instead — alert
// for events that have other attendees (a real meeting), not personal blocks.
export function passesIcloudFilter(e: IcloudCalEvent, now: Date): CalendarEventForAlert | null {
  if (e.allDay) return null;
  if (e.start.getTime() <= now.getTime() + 15 * 60 * 1000) return null;
  if (e.attendeeCount <= 0) return null;
  return { id: `icloud:${e.uid}`, title: e.title, start: e.start, source: 'icloud' };
}

export async function fetchPreAlertEligibleEvents(): Promise<CalendarEventForAlert[]> {
  // Background paths (e.g. push-triggered pre-alerts) may run before any
  // React component has mounted the flag-store hook. Awaiting load is a
  // cheap no-op if the cache is already populated.
  await loadIntegrationFlags();
  const now = new Date();
  const end = endOfToday(now);
  const results: CalendarEventForAlert[] = [];

  // Per-calendar visibility (the calendar picker's hidden set). Respect it so a
  // meeting on a calendar the user explicitly hid doesn't still fire a pre-alert.
  // Background path, so use the non-hook loader; empty set when no user.
  const userId = getActiveUserId();
  const visibility = userId ? await loadCalendarVisibility(userId) : {};

  // Skip providers the user has explicitly disabled. The flag is read
  // sync from the in-memory cache; if the cache hasn't loaded yet (rare
  // during a cold pre-alert run) we err on the side of fetching, since
  // missing the alert is worse than firing for an unused integration.
  if (getIntegrationFlag('google-calendar') !== false) {
    // Google pre-alerts read only the primary calendar, so hidden secondary
    // calendars never reach here — no per-calendar filtering needed.
    const google = await listGoogleEvents(now, end).catch((err) => {
      if (__DEV__) console.warn('[calendar-events-today] google fetch failed:', err);
      return [] as GoogleCalendarEvent[];
    });
    for (const e of google) {
      const passed = passesGoogleFilter(e, now);
      if (passed) results.push(passed);
    }
  }

  if (getIntegrationFlag('outlook-calendar') !== false) {
    // null = fan-in across all calendars; each event carries calendarId so we
    // can drop ones on a hidden calendar below.
    const graph = await listGraphEventsWithCalendarId(now, end, null).catch((err) => {
      if (__DEV__) console.warn('[calendar-events-today] graph fetch failed:', err);
      return [] as Array<GraphCalendarEvent & { calendarId: string | undefined }>;
    });
    for (const e of graph) {
      // Undefined calendarId (rare) → treat as visible; missing an alert is
      // worse than firing for an un-hidden calendar.
      if (e.calendarId && !isCalendarVisible(visibility, 'microsoft', e.calendarId)) continue;
      const passed = passesGraphFilter(e, now);
      if (passed) results.push(passed);
    }
  }

  // iCloud needs the user id to load its CalDAV credential (the OAuth providers
  // use the global session). Skip silently if there's no active user.
  if (userId && getIntegrationFlag('icloud') !== false) {
    const res = await listIcloudEvents(userId, now, end).catch((err) => {
      if (__DEV__) console.warn('[calendar-events-today] icloud fetch failed:', err);
      return { ok: false } as const;
    });
    if (res.ok) {
      for (const e of res.data) {
        if (!isCalendarVisible(visibility, 'icloud', e.calendarUrl)) continue;
        const passed = passesIcloudFilter(e, now);
        if (passed) results.push(passed);
      }
    }
  }

  return results;
}
