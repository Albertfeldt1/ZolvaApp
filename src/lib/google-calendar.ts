// Minimal Google Calendar client. Reads events from the user's primary
// calendar using the OAuth provider_token returned by Supabase after
// signing in with Google (scope: calendar.events + calendar.freebusy).

import { ProviderAuthError, tryWithRefresh } from './auth';
import { fetchWithTimeout } from './network-errors';

const BASE = 'https://www.googleapis.com/calendar/v3';

export type GoogleCalendarAttendee = {
  email?: string;
  displayName?: string;
  self?: boolean;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
};

export type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: GoogleCalendarAttendee[];
};

// Google Calendar event color palette (colorId "1"-"11"). Values from the
// /calendar/v3/colors endpoint — the palette is stable, hardcoded to avoid
// a second round-trip per calendar fetch.
export const GOOGLE_EVENT_COLORS: Record<string, string> = {
  '1': '#7986CB', // Lavender
  '2': '#33B679', // Sage
  '3': '#8E24AA', // Grape
  '4': '#E67C73', // Flamingo
  '5': '#F6BF26', // Banana
  '6': '#F4511E', // Tangerine
  '7': '#039BE5', // Peacock
  '8': '#616161', // Graphite
  '9': '#3F51B5', // Blueberry
  '10': '#0B8043', // Basil
  '11': '#D50000', // Tomato
};

// Google's default color for an event with no explicit colorId set — the
// primary calendar's default ("Blueberry").
export const GOOGLE_DEFAULT_EVENT_COLOR = GOOGLE_EVENT_COLORS['9'];

export function resolveGoogleEventColor(e: GoogleCalendarEvent): string {
  if (e.colorId && GOOGLE_EVENT_COLORS[e.colorId]) {
    return GOOGLE_EVENT_COLORS[e.colorId];
  }
  return GOOGLE_DEFAULT_EVENT_COLOR;
}

// Narrow the payload to the fields we actually consume. Without this the
// events.list response includes organizer, creator, conferenceData, etc.
const EVENT_FIELDS =
  'items(id,summary,description,location,colorId,start,end,' +
  'attendees(email,displayName,self,responseStatus))';

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
      fields: EVENT_FIELDS,
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

// ─── Writes ───────────────────────────────────────────────────────────────

export type GoogleEventInput = {
  title: string;
  start: Date;
  end: Date;
  isAllDay?: boolean;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string; name?: string }>;
};

// All-day events use date-only; timed events use the ISO 8601 dateTime
// preserving the offset that came in. Google honours the offset and
// doesn't need a separate timeZone field for the event-edit case.
function toGoogleDateTime(d: Date, isAllDay: boolean): { dateTime?: string; date?: string } {
  if (isAllDay) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return { date: `${yyyy}-${mm}-${dd}` };
  }
  return { dateTime: d.toISOString() };
}

function buildGoogleEventBody(input: GoogleEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: input.title,
    start: toGoogleDateTime(input.start, !!input.isAllDay),
    end: toGoogleDateTime(input.end, !!input.isAllDay),
  };
  if (input.location) body.location = input.location;
  if (input.description) body.description = input.description;
  if (input.attendees && input.attendees.length > 0) {
    body.attendees = input.attendees.map((a) => ({
      email: a.email,
      displayName: a.name,
    }));
  }
  return body;
}

export async function createEvent(input: GoogleEventInput): Promise<{ id: string }> {
  return tryWithRefresh('google', async (accessToken) => {
    // sendUpdates=all so attendees actually receive the invitation. With no
    // attendees this is a no-op — Google ignores the param.
    const url = `${BASE}/calendars/primary/events?sendUpdates=all`;
    const res = await fetchWithTimeout('google', url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildGoogleEventBody(input)),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Google Calendar afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Google Calendar create failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { id: string };
    return { id: data.id };
  });
}

export async function updateEvent(
  id: string,
  input: Partial<GoogleEventInput>,
): Promise<void> {
  return tryWithRefresh('google', async (accessToken) => {
    // PATCH accepts a partial body. Forward only the fields the caller sent;
    // start/end always travel together because Google rejects a partial pair.
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.summary = input.title;
    if (input.location !== undefined) body.location = input.location;
    if (input.description !== undefined) body.description = input.description;
    if (input.start && input.end) {
      body.start = toGoogleDateTime(input.start, !!input.isAllDay);
      body.end = toGoogleDateTime(input.end, !!input.isAllDay);
    }
    if (input.attendees !== undefined) {
      body.attendees = input.attendees.map((a) => ({
        email: a.email,
        displayName: a.name,
      }));
    }
    const url = `${BASE}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`;
    const res = await fetchWithTimeout('google', url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Google Calendar afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Google Calendar update failed: ${res.status} ${await res.text()}`);
    }
  });
}

export async function deleteEvent(id: string): Promise<void> {
  return tryWithRefresh('google', async (accessToken) => {
    const url = `${BASE}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`;
    const res = await fetchWithTimeout('google', url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Google Calendar afvist (${res.status}).`);
    }
    // 410 Gone = already deleted; treat as success so retries are idempotent.
    if (!res.ok && res.status !== 410) {
      throw new Error(`Google Calendar delete failed: ${res.status} ${await res.text()}`);
    }
  });
}
