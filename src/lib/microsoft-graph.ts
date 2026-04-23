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

export type GraphAttendee = {
  name?: string;
  email?: string;
};

export type GraphCalendarEvent = {
  id: string;
  subject: string;
  start: Date;
  end: Date;
  location?: string;
  isAllDay: boolean;
  hasOtherAttendees: boolean;
  userResponse: GraphAttendeeStatus;
  description?: string;
  attendeeList: GraphAttendee[];
  categories: string[];
  categoryColor?: string;
};

// Outlook master-category preset → hex. The preset strings are part of the
// Graph schema; values approximate what Outlook renders. `none` means the
// user picked a category without a color.
const OUTLOOK_PRESET_COLORS: Record<string, string> = {
  preset0: '#E7453C',
  preset1: '#F9A03C',
  preset2: '#FDC68C',
  preset3: '#F7E269',
  preset4: '#6BCB5F',
  preset5: '#52D1DA',
  preset6: '#A9C26D',
  preset7: '#2F97F9',
  preset8: '#9569E4',
  preset9: '#E84D8F',
  preset10: '#8C8C8C',
  preset11: '#454545',
  preset12: '#B8B8B8',
  preset13: '#6D6D6D',
  preset14: '#222222',
  preset15: '#9B2210',
  preset16: '#CC6E00',
  preset17: '#D69B72',
  preset18: '#CCB300',
  preset19: '#1F7A13',
  preset20: '#1A8A93',
  preset21: '#4E7011',
  preset22: '#004B9B',
  preset23: '#4E2F89',
  preset24: '#9B0952',
};

type MasterCategory = { displayName?: string; color?: string };

// Cache master categories across renders. The master-category list almost
// never changes, so a single fetch per session is plenty. `null` means we
// tried and failed (usually a scope/permissions issue on older tenants) —
// we don't keep retrying in that case.
let masterCategoryCache: Map<string, string> | null | undefined;
let masterCategoryFetchPromise: Promise<Map<string, string> | null> | null =
  null;

async function loadMasterCategories(): Promise<Map<string, string> | null> {
  if (masterCategoryCache !== undefined) return masterCategoryCache;
  if (masterCategoryFetchPromise) return masterCategoryFetchPromise;
  masterCategoryFetchPromise = tryWithRefresh('microsoft', async (token) => {
    try {
      const data = await graphFetch<{ value: MasterCategory[] }>(
        token,
        `/me/outlook/masterCategories`,
      );
      const map = new Map<string, string>();
      for (const c of data.value ?? []) {
        if (!c.displayName || !c.color) continue;
        const hex = OUTLOOK_PRESET_COLORS[c.color];
        if (hex) map.set(c.displayName, hex);
      }
      masterCategoryCache = map;
      return map;
    } catch (err) {
      if (__DEV__) console.warn('[graph] masterCategories fetch failed:', err);
      masterCategoryCache = null;
      return null;
    }
  }).finally(() => {
    masterCategoryFetchPromise = null;
  });
  return masterCategoryFetchPromise;
}

function resolveCategoryColor(
  categories: string[],
  categoryMap: Map<string, string> | null,
): string | undefined {
  if (!categoryMap) return undefined;
  for (const name of categories) {
    const hex = categoryMap.get(name);
    if (hex) return hex;
  }
  return undefined;
}

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
  attendees?: Array<{
    emailAddress?: { name?: string; address?: string };
  }>;
  responseStatus?: { response?: GraphAttendeeStatus };
  body?: { contentType?: string; content?: string };
  categories?: string[];
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
  // Master categories fetch is fire-and-forget: if it resolves before the
  // events do (usually the case after warm cache) we get colors; otherwise
  // events render in the palette fallback.
  const categoryMapPromise = loadMasterCategories();
  return tryWithRefresh('microsoft', async (token) => {
    const path =
      `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}` +
      `&$select=id,subject,start,end,location,isAllDay,attendees,responseStatus,body,categories` +
      `&$orderby=start/dateTime&$top=50`;
    const [data, categoryMap] = await Promise.all([
      graphFetch<{ value: RawEvent[] }>(token, path),
      categoryMapPromise,
    ]);
    return (data.value ?? []).map((e): GraphCalendarEvent => {
      const attendeeList: GraphAttendee[] = (e.attendees ?? []).map((a) => ({
        name: a.emailAddress?.name,
        email: a.emailAddress?.address,
      }));
      const categories = e.categories ?? [];
      const rawBody = e.body?.content ?? '';
      const description =
        e.body?.contentType === 'html' ? stripHtml(rawBody) : rawBody;
      return {
        id: e.id,
        subject: e.subject || 'Uden titel',
        start: new Date(`${e.start.dateTime}Z`),
        end: new Date(`${e.end.dateTime}Z`),
        location: e.location?.displayName,
        isAllDay: e.isAllDay ?? false,
        hasOtherAttendees: attendeeList.length > 0,
        userResponse: e.responseStatus?.response ?? 'none',
        description: description || undefined,
        attendeeList,
        categories,
        categoryColor: resolveCategoryColor(categories, categoryMap),
      };
    });
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
