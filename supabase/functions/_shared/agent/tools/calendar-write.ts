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

const GRAPH_EVENTS = 'https://graph.microsoft.com/v1.0/me/events';

// Graph wants a naive datetime plus an explicit timeZone; our contract is that
// callers pass UTC ISO ending in Z, so drop the Z and label it UTC.
function stripZone(iso: string): string {
  return iso.replace(/Z$/, '');
}

export async function outlookCreateEvent(
  input: CreateEventInput,
): Promise<{ eventId: string; reverseToken: GraphEventDeleteToken }> {
  const body: Record<string, unknown> = {
    subject: input.title,
    start: { dateTime: stripZone(input.startIso), timeZone: 'UTC' },
    end: { dateTime: stripZone(input.endIso), timeZone: 'UTC' },
  };
  if (input.location) body.location = { displayName: input.location };
  if (input.attendees && input.attendees.length) {
    body.attendees = input.attendees.map((address) => ({
      emailAddress: { address },
      type: 'required',
    }));
  }
  const res = await input.fetch(GRAPH_EVENTS, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph events.create ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('graph events.create: response missing id');
  return { eventId: j.id, reverseToken: { kind: 'graph.event_delete', provider: 'microsoft', event_id: j.id } };
}

export async function googleDeleteEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
}): Promise<void> {
  const res = await input.fetch(`${GCAL_EVENTS}/${encodeURIComponent(input.eventId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  // 404/410 = already gone — for an undo that's the desired end state.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.delete ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function outlookDeleteEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
}): Promise<void> {
  const res = await input.fetch(`${GRAPH_EVENTS}/${encodeURIComponent(input.eventId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  // 404/410 = already gone — for an undo that's the desired end state.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph events.delete ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function googlePatchEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
  patch: EventPatch;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  if (input.patch.title !== undefined) body.summary = input.patch.title;
  if (input.patch.startIso !== undefined) body.start = { dateTime: input.patch.startIso, timeZone: 'UTC' };
  if (input.patch.endIso !== undefined) body.end = { dateTime: input.patch.endIso, timeZone: 'UTC' };
  if (input.patch.location !== undefined) body.location = input.patch.location;
  const res = await input.fetch(`${GCAL_EVENTS}/${encodeURIComponent(input.eventId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.patch ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function outlookPatchEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
  patch: EventPatch;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  if (input.patch.title !== undefined) body.subject = input.patch.title;
  if (input.patch.startIso !== undefined) body.start = { dateTime: stripZone(input.patch.startIso), timeZone: 'UTC' };
  if (input.patch.endIso !== undefined) body.end = { dateTime: stripZone(input.patch.endIso), timeZone: 'UTC' };
  if (input.patch.location !== undefined) body.location = { displayName: input.patch.location };
  const res = await input.fetch(`${GRAPH_EVENTS}/${encodeURIComponent(input.eventId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph events.patch ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function googleGetEventPatch(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
}): Promise<EventPatch> {
  const res = await input.fetch(
    `${GCAL_EVENTS}/${encodeURIComponent(input.eventId)}?fields=summary,start,end,location`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.get ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
  };
  return {
    title: j.summary,
    startIso: j.start?.dateTime ?? j.start?.date,
    endIso: j.end?.dateTime ?? j.end?.date,
    location: j.location,
  };
}

export async function outlookGetEventPatch(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
}): Promise<EventPatch> {
  const res = await input.fetch(
    `${GRAPH_EVENTS}/${encodeURIComponent(input.eventId)}?$select=subject,start,end,location`,
    { headers: { authorization: `Bearer ${input.accessToken}`, prefer: 'outlook.timezone="UTC"' } },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph events.get ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    subject?: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
    location?: { displayName?: string };
  };
  return {
    title: j.subject,
    startIso: j.start?.dateTime,
    endIso: j.end?.dateTime,
    location: j.location?.displayName,
  };
}
