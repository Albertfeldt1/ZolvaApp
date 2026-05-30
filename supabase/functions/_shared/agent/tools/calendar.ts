// Read-only calendar tool for the agent. Returns events in [startIso, endIso].
// Google: /calendar/v3/calendars/primary/events with singleEvents=true expansion.
// Outlook: /me/calendarView (expands recurring instances natively).

export type CalFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface CalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location: string | null;
}

export async function googleListEvents(input: {
  fetch: CalFetch;
  accessToken: string;
  startIso: string;
  endIso: string;
}): Promise<CalEvent[]> {
  const params = new URLSearchParams({
    timeMin: input.startIso,
    timeMax: input.endIso,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
    fields: 'items(id,summary,start,end,attendees(email,self),location)',
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;
  const res = await input.fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.list ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      id?: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      attendees?: Array<{ email?: string; self?: boolean }>;
      location?: string;
    }>;
  };
  return (json.items ?? []).map((it) => ({
    id: it.id ?? '',
    title: it.summary ?? '(uden titel)',
    start: it.start?.dateTime ?? it.start?.date ?? '',
    end: it.end?.dateTime ?? it.end?.date ?? '',
    attendees: (it.attendees ?? [])
      .filter((a) => a.self !== true && !!a.email)
      .map((a) => a.email as string),
    location: it.location ?? null,
  }));
}

export async function outlookListEvents(input: {
  fetch: CalFetch;
  accessToken: string;
  startIso: string;
  endIso: string;
}): Promise<CalEvent[]> {
  const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${
    encodeURIComponent(input.startIso)
  }&endDateTime=${encodeURIComponent(input.endIso)}&$top=50&$select=id,subject,start,end,attendees,location`;
  const res = await input.fetch(url, {
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph calendarView ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    value?: Array<{
      id?: string;
      subject?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      attendees?: Array<{ emailAddress?: { address?: string }; type?: string }>;
      location?: { displayName?: string };
    }>;
  };
  return (json.value ?? []).map((it) => ({
    id: it.id ?? '',
    title: it.subject ?? '(uden titel)',
    start: it.start?.dateTime ?? '',
    end: it.end?.dateTime ?? '',
    attendees: (it.attendees ?? [])
      .filter((a) => a.type !== 'resource' && !!a.emailAddress?.address)
      .map((a) => a.emailAddress!.address as string),
    location: it.location?.displayName ?? null,
  }));
}
