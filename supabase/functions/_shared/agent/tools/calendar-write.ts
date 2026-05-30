// Write tools for the agent: create / update calendar events on Google + Outlook.
// Sits beside the read-only calendar.ts. Each create returns a delete reverse
// token; each update reads-then-patches and returns a restore reverse token
// carrying the prior field values.

export type CalWriteFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

// A provider-neutral set of mutable event fields. Used both as the update
// payload and as the captured "prior" state inside a restore reverse token.
export interface EventPatch {
  title?: string;
  startIso?: string;
  endIso?: string;
  location?: string;
}

export interface GcalEventDeleteToken {
  kind: 'gcal.event_delete';
  provider: 'google';
  event_id: string;
}
export interface GcalEventRestoreToken {
  kind: 'gcal.event_restore';
  provider: 'google';
  event_id: string;
  prior: EventPatch;
}
export interface GraphEventDeleteToken {
  kind: 'graph.event_delete';
  provider: 'microsoft';
  event_id: string;
}
export interface GraphEventRestoreToken {
  kind: 'graph.event_restore';
  provider: 'microsoft';
  event_id: string;
  prior: EventPatch;
}

export interface CreateEventInput {
  fetch: CalWriteFetch;
  accessToken: string;
  title: string;
  startIso: string;
  endIso: string;
  attendees?: string[];
  location?: string;
}

const GCAL_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export async function googleCreateEvent(
  input: CreateEventInput,
): Promise<{ eventId: string; reverseToken: GcalEventDeleteToken }> {
  const body: Record<string, unknown> = {
    summary: input.title,
    start: { dateTime: input.startIso, timeZone: 'UTC' },
    end: { dateTime: input.endIso, timeZone: 'UTC' },
  };
  if (input.location) body.location = input.location;
  if (input.attendees && input.attendees.length) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  const res = await input.fetch(GCAL_EVENTS, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.create ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('google calendar.create: response missing id');
  return { eventId: j.id, reverseToken: { kind: 'gcal.event_delete', provider: 'google', event_id: j.id } };
}
