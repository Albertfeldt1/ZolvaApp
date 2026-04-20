// Minimal Microsoft Graph client. Reads inbox messages and calendar events
// for the signed-in Microsoft account.

import { ProviderAuthError, tryWithRefresh } from './auth';
import { fetchWithTimeout } from './network-errors';

const BASE = 'https://graph.microsoft.com/v1.0';

export type GraphMessage = {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  preview: string;
  isRead: boolean;
};

export type GraphMessageBody = {
  id: string;
  from: string;
  fromEmail: string;
  subject: string;
  text: string;
};

export type GraphAttendeeStatus = 'none' | 'accepted' | 'tentativelyAccepted' | 'declined' | 'notResponded' | 'organizer';

export type GraphCalendarEvent = {
  id: string;
  subject: string;
  start: Date;
  end: Date;
  location?: string;
  isAllDay: boolean;
  hasOtherAttendees: boolean;
  userResponse: GraphAttendeeStatus;
};

type RawMessage = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime: string;
  isRead?: boolean;
  from?: { emailAddress?: { name?: string; address?: string } };
};

type RawMessageFull = RawMessage & {
  body?: { contentType?: string; content?: string };
};

type RawEvent = {
  id: string;
  subject?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  location?: { displayName?: string };
  isAllDay?: boolean;
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  responseStatus?: { response?: GraphAttendeeStatus };
};

async function graphFetch<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchWithTimeout('microsoft', `${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC"',
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProviderAuthError('microsoft', `Microsoft Graph afvist (${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(`Microsoft Graph ${res.status}: ${await res.text()}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function listInboxMessages(top = 12): Promise<GraphMessage[]> {
  return tryWithRefresh('microsoft', async (token) => {
    const data = await graphFetch<{ value: RawMessage[] }>(
      token,
      `/me/messages?$top=${top}&$select=id,from,subject,bodyPreview,receivedDateTime,isRead&$orderby=receivedDateTime desc`,
    );
    return (data.value ?? []).map((m) => ({
      id: m.id,
      from:
        m.from?.emailAddress?.name ??
        m.from?.emailAddress?.address ??
        '(ukendt afsender)',
      subject: m.subject || '(intet emne)',
      receivedAt: new Date(m.receivedDateTime),
      preview: m.bodyPreview ?? '',
      isRead: m.isRead ?? false,
    }));
  });
}

export async function getMessageBody(id: string): Promise<GraphMessageBody> {
  return tryWithRefresh('microsoft', async (token) => {
    const data = await graphFetch<RawMessageFull>(
      token,
      `/me/messages/${id}?$select=id,subject,from,body,bodyPreview`,
    );
    const rawBody = data.body?.content ?? '';
    const text =
      data.body?.contentType === 'html'
        ? stripHtml(rawBody)
        : rawBody || data.bodyPreview || '';
    return {
      id: data.id,
      from:
        data.from?.emailAddress?.name ??
        data.from?.emailAddress?.address ??
        '(ukendt afsender)',
      fromEmail: data.from?.emailAddress?.address ?? '',
      subject: data.subject || '(intet emne)',
      text,
    };
  });
}

export async function replyToMessage(id: string, body: string): Promise<void> {
  return tryWithRefresh('microsoft', async (token) => {
    await graphFetch<void>(token, `/me/messages/${id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: body }),
    });
  });
}

export async function archiveMessage(id: string): Promise<void> {
  return tryWithRefresh('microsoft', async (token) => {
    // Mark as read first; if the PATCH fails we still attempt the move.
    try {
      await graphFetch<void>(token, `/me/messages/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true }),
      });
    } catch (err) {
      if (__DEV__) console.warn('[graph] mark read failed:', err);
    }
    await graphFetch<void>(token, `/me/messages/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationId: 'archive' }),
    });
  });
}

export async function listCalendarEvents(
  start: Date,
  end: Date,
): Promise<GraphCalendarEvent[]> {
  return tryWithRefresh('microsoft', async (token) => {
    const path =
      `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}` +
      `&$select=id,subject,start,end,location,isAllDay,attendees,responseStatus` +
      `&$orderby=start/dateTime&$top=50`;
    const data = await graphFetch<{ value: RawEvent[] }>(token, path);
    return (data.value ?? []).map((e) => ({
      id: e.id,
      subject: e.subject || 'Uden titel',
      start: new Date(`${e.start.dateTime}Z`),
      end: new Date(`${e.end.dateTime}Z`),
      location: e.location?.displayName,
      isAllDay: e.isAllDay ?? false,
      hasOtherAttendees: (e.attendees ?? []).length > 0,
      userResponse: e.responseStatus?.response ?? 'none',
    }));
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|td|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
