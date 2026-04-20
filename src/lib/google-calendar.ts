// Minimal Google Calendar client. Reads events from the user's primary
// calendar using the OAuth provider_token returned by Supabase after
// signing in with Google (scope: calendar.readonly).

import { ProviderAuthError, tryWithRefresh } from './auth';
import { fetchWithTimeout } from './network-errors';

const BASE = 'https://www.googleapis.com/calendar/v3';

export type GoogleCalendarAttendee = {
  email?: string;
  self?: boolean;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
};

export type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: GoogleCalendarAttendee[];
};

export async function listEvents(
  timeMin: Date,
  timeMax: Date,
): Promise<GoogleCalendarEvent[]> {
  return tryWithRefresh('google', async (accessToken) => {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
    const url = `${BASE}/calendars/primary/events?${params.toString()}`;
    const res = await fetchWithTimeout('google', url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Google Calendar afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Google Calendar API ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { items?: GoogleCalendarEvent[] };
    return json.items ?? [];
  });
}

export function eventStart(e: GoogleCalendarEvent): Date | null {
  const raw = e.start.dateTime ?? e.start.date;
  if (!raw) return null;
  return new Date(raw);
}

export function eventEnd(e: GoogleCalendarEvent): Date | null {
  const raw = e.end.dateTime ?? e.end.date;
  if (!raw) return null;
  return new Date(raw);
}

export function isAllDay(e: GoogleCalendarEvent): boolean {
  return !e.start.dateTime && !!e.start.date;
}

// True when the event has at least one attendee other than the signed-in
// user. Google includes the organizer themselves in `attendees`; we treat
// events with only the `self: true` attendee as solo.
export function hasOtherAttendees(e: GoogleCalendarEvent): boolean {
  const list = e.attendees ?? [];
  return list.some((a) => a.self !== true);
}

// True when the signed-in user has accepted the event. If there are no
// attendees at all, this returns true (solo events count as accepted even
// though `hasOtherAttendees` will filter them out separately).
export function userAccepted(e: GoogleCalendarEvent): boolean {
  const list = e.attendees ?? [];
  if (list.length === 0) return true;
  const me = list.find((a) => a.self === true);
  if (!me) return true;
  return me.responseStatus === 'accepted';
}
