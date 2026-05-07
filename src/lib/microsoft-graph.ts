// Minimal Microsoft Graph client. Reads inbox messages and calendar events
// for the signed-in Microsoft account.

import { ProviderAuthError, tryWithRefresh } from './auth';
import { buildOutgoingBody } from './mail-signature';
import type { InlineAttachmentSpec, OutgoingBody } from './mail-signature';
import { fetchWithTimeout, NetworkTimeoutError } from './network-errors';

type GraphFileAttachment = {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
  isInline: boolean;
  contentId: string;
};

function toGraphAttachments(specs: InlineAttachmentSpec[]): GraphFileAttachment[] {
  return specs.map((s) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: s.filename,
    contentType: s.mimeType,
    contentBytes: s.contentBytes,
    isInline: true,
    contentId: s.contentId,
  }));
}

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
// tried and failed (usually a scope/permissions issue on older tenants) -
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

// One retry on transient failures (timeout, 5xx) for read-only list calls.
// Restricted to listInboxMessages because mutations (send, archive) MUST NOT
// retry on timeout - the request may have already succeeded server-side.
async function listFetchWithRetry<T>(token: string, path: string): Promise<T> {
  try {
    return await graphFetch<T>(token, path);
  } catch (err) {
    const isTransient =
      err instanceof NetworkTimeoutError ||
      (err instanceof Error && /^Microsoft Graph 5\d\d:/.test(err.message));
    if (!isTransient) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    return await graphFetch<T>(token, path);
  }
}

// Server-reported INBOX counts. Total is the all-time totalItemCount from
// /mailFolders/inbox; unread is scoped to "Focused" inbox + the past 7
// days so the "venter pa dig" stat matches the user's mental model.
// Excluding inferenceClassification eq 'other' keeps newsletters and
// auto-classified noise from inflating the number the same way Gmail's
// Promotions tab used to. $count=true + ConsistencyLevel: eventual is
// required for filtered counts on Graph.
export async function getInboxCounts(): Promise<{ total: number; unread: number }> {
  return tryWithRefresh('microsoft', async (token) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const filter = encodeURIComponent(
      `isRead eq false and receivedDateTime ge ${since} and inferenceClassification eq 'focused'`,
    );
    const [folder, recent] = await Promise.all([
      graphFetch<{ totalItemCount?: number }>(
        token,
        `/me/mailFolders/inbox?$select=totalItemCount`,
      ),
      graphFetch<{ '@odata.count'?: number }>(
        token,
        `/me/mailFolders/inbox/messages?$filter=${filter}&$count=true&$top=1&$select=id`,
        { headers: { ConsistencyLevel: 'eventual' } },
      ),
    ]);
    return {
      total: folder.totalItemCount ?? 0,
      unread: recent['@odata.count'] ?? 0,
    };
  });
}

export async function listInboxMessages(top = 12): Promise<GraphMessage[]> {
  return tryWithRefresh('microsoft', async (token) => {
    // Folder-scoped to /mailFolders/inbox/messages - /me/messages returns
    // messages from across the entire mailbox (Inbox + Sent + Drafts + Junk).
    // Active Outlook users have Sent items and already-read mail dominating
    // the top of /me/messages, which crowded out their unread Inbox mail
    // once the downstream `!isRead` filter ran. Matches Gmail's `q=in:inbox`.
    const data = await listFetchWithRetry<{ value: RawMessage[] }>(
      token,
      `/me/mailFolders/inbox/messages?$top=${top}&$select=id,from,subject,bodyPreview,receivedDateTime,isRead&$orderby=receivedDateTime desc`,
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

// Sends an immediate reply. For users with no signature configured this
// stays a single API call (POST /reply with `comment`). For users with
// a rich signature we createReply → PATCH HTML body → POST inline
// attachments → POST send. 4 round-trips when a signature is configured;
// 1 when it isn't. Acceptable - replies aren't latency-critical and the
// /reply endpoint can't carry inline attachments.
export async function replyToMessage(id: string, body: string): Promise<void> {
  return tryWithRefresh('microsoft', async (token) => {
    const built: OutgoingBody = await buildOutgoingBody(body);

    if (built.contentType === 'text' && built.attachments.length === 0) {
      await graphFetch<void>(token, `/me/messages/${id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: built.content }),
      });
      return;
    }

    const draft = await graphFetch<{ id: string }>(
      token,
      `/me/messages/${id}/createReply`,
      { method: 'POST' },
    );
    await graphFetch<void>(token, `/me/messages/${draft.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: { contentType: built.contentType, content: built.content },
      }),
    });
    const attachments = toGraphAttachments(built.attachments);
    for (const att of attachments) {
      await graphFetch<void>(token, `/me/messages/${draft.id}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(att),
      });
    }
    await graphFetch<void>(token, `/me/messages/${draft.id}/send`, { method: 'POST' });
  });
}

export type GraphComposeInput = {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  // For a reply draft, supply the original message id. We post to
  // /messages/{id}/createReplyDraft so Outlook builds the threading + quoted
  // history automatically; subject/body still get our signature appended.
  replyToId?: string;
};

function buildRecipients(addrs: string[]): Array<{ emailAddress: { address: string } }> {
  return addrs.map((a) => ({ emailAddress: { address: a } }));
}

export async function createDraft(input: GraphComposeInput): Promise<{ id: string }> {
  return tryWithRefresh('microsoft', async (token) => {
    const built: OutgoingBody = await buildOutgoingBody(input.body);
    const attachments = toGraphAttachments(built.attachments);

    if (input.replyToId) {
      const draft = await graphFetch<{ id: string }>(
        token,
        `/me/messages/${input.replyToId}/createReplyDraft`,
        { method: 'POST' },
      );
      await graphFetch<void>(token, `/me/messages/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: { contentType: built.contentType, content: built.content },
        }),
      });
      for (const att of attachments) {
        await graphFetch<void>(token, `/me/messages/${draft.id}/attachments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(att),
        });
      }
      return { id: draft.id };
    }

    const data = await graphFetch<{ id: string }>(token, `/me/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: input.subject,
        body: { contentType: built.contentType, content: built.content },
        toRecipients: buildRecipients(input.to),
        ccRecipients: input.cc && input.cc.length > 0 ? buildRecipients(input.cc) : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      }),
    });
    return { id: data.id };
  });
}

export async function sendMail(input: GraphComposeInput): Promise<void> {
  if (input.replyToId) {
    // Defensive: route to replyToMessage so the rich-signature reply
    // path handles inline attachments correctly.
    return replyToMessage(input.replyToId, input.body);
  }
  return tryWithRefresh('microsoft', async (token) => {
    const built: OutgoingBody = await buildOutgoingBody(input.body);
    const attachments = toGraphAttachments(built.attachments);
    await graphFetch<void>(token, `/me/sendMail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: built.contentType, content: built.content },
          toRecipients: buildRecipients(input.to),
          ccRecipients: input.cc && input.cc.length > 0 ? buildRecipients(input.cc) : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        saveToSentItems: true,
      }),
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
  return listCalendarEventsForCalendars(start, end, null);
}

// `calendarIds === null` keeps the legacy /me/calendarView fan-in across
// every calendar in the mailbox (used by brief / chat). When passed a list,
// we still hit /me/calendarView (cheaper than per-calendar fan-out) and
// drop events whose source calendar isn't in the visible set. Each event
// returned carries `calendarId` for downstream filtering/coloring.
export async function listCalendarEventsForCalendars(
  start: Date,
  end: Date,
  calendarIds: string[] | null,
): Promise<Array<GraphCalendarEvent & { calendarId: string | undefined }>> {
  // Master categories fetch is fire-and-forget: if it resolves before the
  // events do (usually the case after warm cache) we get colors; otherwise
  // events render in the palette fallback.
  const categoryMapPromise = loadMasterCategories();
  return tryWithRefresh('microsoft', async (token) => {
    const path =
      `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}` +
      `&$select=id,subject,start,end,location,isAllDay,attendees,responseStatus,body,categories` +
      `&$expand=calendar($select=id)` +
      `&$orderby=start/dateTime&$top=50`;
    const [data, categoryMap] = await Promise.all([
      graphFetch<{ value: Array<RawEvent & { calendar?: { id?: string } }> }>(token, path),
      categoryMapPromise,
    ]);
    const visible = calendarIds ? new Set(calendarIds) : null;
    return (data.value ?? [])
      .filter((e) => !visible || (e.calendar?.id != null && visible.has(e.calendar.id)))
      .map((e) => {
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
          calendarId: e.calendar?.id,
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

// ─── Calendar writes ──────────────────────────────────────────────────────
//
// Microsoft Graph accepts UTC datetime strings without offsets when paired
// with timeZone="UTC". We always serialize Date → UTC and tell Graph that's
// what we mean - display-side rendering uses the device's local TZ which
// matches how listCalendarEvents reads them back.

export type GraphEventInput = {
  title: string;
  start: Date;
  end: Date;
  isAllDay?: boolean;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string; name?: string }>;
  // Target a specific Microsoft calendar by id. Omit to write to the
  // mailbox's default calendar (legacy behavior).
  calendarId?: string;
};

function toGraphDateTime(d: Date, isAllDay: boolean): { dateTime: string; timeZone: string } {
  if (isAllDay) {
    // All-day events use date-only and Graph requires the timeZone field
    // even though the value is irrelevant in that case.
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return { dateTime: `${yyyy}-${mm}-${dd}T00:00:00`, timeZone: 'UTC' };
  }
  return { dateTime: d.toISOString().replace(/\.\d{3}Z$/, ''), timeZone: 'UTC' };
}

function buildGraphEventBody(input: GraphEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subject: input.title,
    start: toGraphDateTime(input.start, !!input.isAllDay),
    end: toGraphDateTime(input.end, !!input.isAllDay),
    isAllDay: !!input.isAllDay,
  };
  if (input.location) body.location = { displayName: input.location };
  if (input.description) {
    body.body = { contentType: 'text', content: input.description };
  }
  if (input.attendees && input.attendees.length > 0) {
    body.attendees = input.attendees.map((a) => ({
      emailAddress: { address: a.email, name: a.name ?? a.email },
      type: 'required',
    }));
  }
  return body;
}

export async function createCalendarEvent(input: GraphEventInput): Promise<{ id: string }> {
  return tryWithRefresh('microsoft', async (token) => {
    const path = input.calendarId
      ? `/me/calendars/${encodeURIComponent(input.calendarId)}/events`
      : `/me/events`;
    const data = await graphFetch<{ id: string }>(token, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildGraphEventBody(input)),
    });
    return { id: data.id };
  });
}

export async function updateCalendarEvent(
  id: string,
  input: Partial<GraphEventInput>,
): Promise<void> {
  return tryWithRefresh('microsoft', async (token) => {
    // PATCH accepts a partial body - only fields you supply are changed. The
    // builder always emits start/end/isAllDay together because Graph rejects
    // a partial start/end pair, so we forward only what the caller sent.
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.subject = input.title;
    if (input.location !== undefined) body.location = { displayName: input.location };
    if (input.description !== undefined) {
      body.body = { contentType: 'text', content: input.description };
    }
    if (input.start && input.end) {
      body.start = toGraphDateTime(input.start, !!input.isAllDay);
      body.end = toGraphDateTime(input.end, !!input.isAllDay);
      body.isAllDay = !!input.isAllDay;
    }
    if (input.attendees !== undefined) {
      body.attendees = input.attendees.map((a) => ({
        emailAddress: { address: a.email, name: a.name ?? a.email },
        type: 'required',
      }));
    }
    await graphFetch<void>(token, `/me/events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  });
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  return tryWithRefresh('microsoft', async (token) => {
    await graphFetch<void>(token, `/me/events/${id}`, {
      method: 'DELETE',
    });
  });
}
