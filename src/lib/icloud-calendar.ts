// src/lib/icloud-calendar.ts
//
// CalDAV client for iCloud. Goes device-direct to caldav.icloud.com over HTTPS.
// Auth is HTTP Basic with email + app-specific password.
//
// Discovery (cached): three round trips to find calendars.
//   1. PROPFIND /.well-known/caldav        → current-user-principal
//   2. PROPFIND <principal>                → calendar-home-set
//   3. PROPFIND <calendar-home> Depth:1    → calendar collections
//
// Split TTL: principal/calendar-home cached 30 days, calendar list cached 24h.

import * as secureStorage from './secure-storage';
import { loadCredential, markInvalid } from './icloud-credentials';

const CALDAV_HOST = 'https://caldav.icloud.com';
const PRINCIPAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CALENDAR_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;

export type IcloudCalendarMeta = {
  url: string;
  displayName: string;
  calendarColor?: string;
};

type CalDiscoveryCache = {
  principalUrl: string;
  calendarHomeUrl: string;
  principalDiscoveredAt: number;
  calendars: IcloudCalendarMeta[];
  calendarsListedAt: number;
};

const discoveryCacheKey = (uid: string) =>
  `zolva.${uid}.icloud.caldav.discovery`;

async function loadDiscoveryCache(userId: string): Promise<CalDiscoveryCache | null> {
  const raw = await secureStorage.getItem(discoveryCacheKey(userId));
  if (!raw) return null;
  try { return JSON.parse(raw) as CalDiscoveryCache; }
  catch { return null; }
}

async function saveDiscoveryCache(userId: string, cache: CalDiscoveryCache): Promise<void> {
  await secureStorage.setItem(discoveryCacheKey(userId), JSON.stringify(cache));
}

async function clearDiscoveryCache(userId: string): Promise<void> {
  await secureStorage.deleteItem(discoveryCacheKey(userId));
}

export async function clearDiscoveryCacheFor(userId: string): Promise<void> {
  // Public re-export so the Settings disconnect flow can wipe state.
  await clearDiscoveryCache(userId);
}

function basicAuth(email: string, password: string): string {
  return 'Basic ' + btoa(`${email}:${password}`);
}

// Action-oriented error codes — mirror the action codes in icloud-mail.ts so
// hook/banner logic stays uniform across providers. 'not-connected' is a
// defense-in-depth fallback (the hook layer gates on kind === 'valid' before
// calling listEvents); 'credential-rejected' is the hot path after Apple
// rejects mid-session and the next call finds the credential flagged invalid.
export type CalDavErrorCode =
  | 'auth-failed'
  | 'network'
  | 'timeout'
  | 'protocol'
  | 'not-connected'         // credential is 'absent' — caller suppresses UI silently
  | 'credential-rejected';  // credential is 'invalid' — caller surfaces re-entry banner

export type CalDavResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CalDavErrorCode };

export async function probeCredential(
  email: string,
  password: string,
): Promise<CalDavResult<{ principalUrl: string }>> {
  // Lightest-weight CalDAV op for the setup-screen dual-probe.
  return await propfindPrincipal(email, password);
}

export async function listEvents(
  userId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<CalDavResult<IcloudCalEvent[]>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };
  const auth = basicAuth(cred.credential.email, cred.credential.password);

  let cache = await loadDiscoveryCache(userId);
  const now = Date.now();
  if (!cache || now - cache.principalDiscoveredAt > PRINCIPAL_TTL_MS) {
    const fresh = await fullDiscover(cred.credential.email, cred.credential.password, userId);
    if (!fresh.ok) {
      if (fresh.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
      return fresh;
    }
    cache = fresh.data;
  } else if (now - cache.calendarsListedAt > CALENDAR_LIST_TTL_MS) {
    const calsRes = await listCalendarsAt(cache.calendarHomeUrl, auth);
    if (!calsRes.ok) {
      if (calsRes.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
      return calsRes;
    }
    cache = { ...cache, calendars: calsRes.data, calendarsListedAt: now };
    await saveDiscoveryCache(userId, cache);
  }

  // (event fetch added in Task 5.3)
  return { ok: true, data: [] };
}

async function fullDiscover(
  email: string,
  password: string,
  userId: string,
): Promise<CalDavResult<CalDiscoveryCache>> {
  const principalRes = await propfindPrincipal(email, password);
  if (!principalRes.ok) return principalRes;
  const principalUrl = principalRes.data.principalUrl;

  const homeRes = await propfindCalendarHome(principalUrl, basicAuth(email, password));
  if (!homeRes.ok) return homeRes;
  const calendarHomeUrl = homeRes.data.calendarHomeUrl;

  const calsRes = await listCalendarsAt(calendarHomeUrl, basicAuth(email, password));
  if (!calsRes.ok) return calsRes;

  const cache: CalDiscoveryCache = {
    principalUrl,
    calendarHomeUrl,
    principalDiscoveredAt: Date.now(),
    calendars: calsRes.data,
    calendarsListedAt: Date.now(),
  };
  await saveDiscoveryCache(userId, cache);
  return { ok: true, data: cache };
}

async function propfindPrincipal(
  email: string,
  password: string,
): Promise<CalDavResult<{ principalUrl: string }>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;
  const res = await caldavFetch(
    `${CALDAV_HOST}/.well-known/caldav`,
    'PROPFIND',
    basicAuth(email, password),
    { Depth: '0' },
    body,
  );
  if (!res.ok) return res;
  const url = extractFirstHref(res.data, 'current-user-principal');
  if (!url) return { ok: false, error: 'protocol' };
  return { ok: true, data: { principalUrl: absolutize(url) } };
}

async function propfindCalendarHome(
  principalUrl: string,
  auth: string,
): Promise<CalDavResult<{ calendarHomeUrl: string }>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;
  const res = await caldavFetch(principalUrl, 'PROPFIND', auth, { Depth: '0' }, body);
  if (!res.ok) return res;
  const url = extractFirstHref(res.data, 'calendar-home-set');
  if (!url) return { ok: false, error: 'protocol' };
  return { ok: true, data: { calendarHomeUrl: absolutize(url) } };
}

async function listCalendarsAt(
  calendarHomeUrl: string,
  auth: string,
): Promise<CalDavResult<IcloudCalendarMeta[]>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <c:supported-calendar-component-set/>
    <x:calendar-color/>
  </d:prop>
</d:propfind>`;
  const res = await caldavFetch(calendarHomeUrl, 'PROPFIND', auth, { Depth: '1' }, body);
  if (!res.ok) return res;
  const cals = parseCalendarList(res.data);
  return { ok: true, data: cals };
}

// XML response parsing — minimal, regex-based (DOMParser would need a polyfill in RN).
// If this proves brittle in practice, swap for fast-xml-parser as a follow-up.

function extractFirstHref(xml: string, propLocal: string): string | null {
  const re = new RegExp(
    `<[^>]*${propLocal}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<\\/[^>]*href[^>]*>[\\s\\S]*?<\\/[^>]*${propLocal}[^>]*>`,
    'i',
  );
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function parseCalendarList(xml: string): IcloudCalendarMeta[] {
  const result: IcloudCalendarMeta[] = [];
  const blocks = xml.split(/<[^>]*:response[^>]*>/i).slice(1);
  for (const blockRaw of blocks) {
    const block = blockRaw.split(/<\/[^>]*:response[^>]*>/i)[0];
    const href = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i)?.[1]?.trim();
    if (!href) continue;
    const supports = block.match(
      /<[^>]*supported-calendar-component-set[^>]*>([\s\S]*?)<\/[^>]*supported-calendar-component-set[^>]*>/i,
    )?.[1] ?? '';
    if (!/<[^>]*comp[^>]*name=["']VEVENT["'][^>]*\/?>/.test(supports)) continue;
    const displayName = block.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname[^>]*>/i)?.[1]?.trim() ?? '(uden navn)';
    const calendarColor = block.match(/<[^>]*calendar-color[^>]*>([^<]+)<\/[^>]*calendar-color[^>]*>/i)?.[1]?.trim();
    result.push({
      url: absolutize(href),
      displayName,
      calendarColor,
    });
  }
  return result;
}

function absolutize(maybeRelative: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  if (maybeRelative.startsWith('/')) return CALDAV_HOST + maybeRelative;
  return `${CALDAV_HOST}/${maybeRelative}`;
}

async function caldavFetch(
  url: string,
  method: string,
  auth: string,
  headers: Record<string, string>,
  body: string,
): Promise<CalDavResult<string>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/xml; charset=utf-8',
        ...headers,
      },
      body,
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'auth-failed' };
  }
  if (res.status === 207 || res.status === 200) {
    return { ok: true, data: await res.text() };
  }
  if (res.status === 404) {
    return { ok: false, error: 'protocol' };
  }
  return { ok: false, error: 'protocol' };
}

export type IcloudCalEvent = {
  uid: string;
  start: Date;
  end: Date;
  allDay: boolean;
  title: string;
  location?: string;
  description?: string;
  calendarColor?: string;
  calendarName: string;
};
