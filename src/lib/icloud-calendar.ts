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

import ICAL from 'ical.js';

import * as secureStorage from './secure-storage';
import { loadCredential, markInvalid } from './icloud-credentials';

const CALDAV_HOST = 'https://caldav.icloud.com';
const PRINCIPAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CALENDAR_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const CALDAV_TIMEOUT_MS = 25_000;
// Used by Task 5.3 for parallel REPORT fan-out across calendars.
const CONCURRENCY = 5;

export type IcloudCalendarMeta = {
  url: string;
  displayName: string;
  calendarColor?: string;
};

// Bump when the cached calendar shape changes meaning (e.g. when the parser
// starts excluding non-calendar collections that older versions stored).
// Pre-versioned caches are treated as a miss.
const DISCOVERY_SCHEMA = 2;

type CalDiscoveryCache = {
  schema: number;
  // Stamped so account rotation (saveCredential with a different Apple ID)
  // can't reuse a stale principalUrl belonging to the previous account.
  email: string;
  principalUrl: string;
  calendarHomeUrl: string;
  principalDiscoveredAt: number;
  calendars: IcloudCalendarMeta[];
  calendarsListedAt: number;
};

const discoveryCacheKey = (uid: string) =>
  `zolva.${uid}.icloud.caldav.discovery`;

function isValidCache(c: Partial<CalDiscoveryCache>): c is CalDiscoveryCache {
  return (
    c.schema === DISCOVERY_SCHEMA &&
    typeof c.email === 'string' &&
    typeof c.principalUrl === 'string' &&
    typeof c.calendarHomeUrl === 'string' &&
    typeof c.principalDiscoveredAt === 'number' &&
    typeof c.calendarsListedAt === 'number' &&
    Array.isArray(c.calendars)
  );
}

async function loadDiscoveryCache(
  userId: string,
  email: string,
): Promise<CalDiscoveryCache | null> {
  const raw = await secureStorage.getItem(discoveryCacheKey(userId));
  if (!raw) return null;
  let parsed: Partial<CalDiscoveryCache>;
  try { parsed = JSON.parse(raw) as Partial<CalDiscoveryCache>; }
  catch { return null; }
  // Treat malformed blobs as cache miss — secureStorage.setItem swallows
  // failures, so partial writes can land here. fullDiscover will repopulate.
  if (!isValidCache(parsed)) return null;
  // Account rotation: stored principalUrl belongs to a different Apple ID.
  if (parsed.email !== email) return null;
  return parsed;
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

// Public wrapper around fullDiscover for the iCloud setup flow. Runs the
// PROPFIND chain (principal → home-set → calendar list), persists the
// discovery cache, and returns the calendarHomeUrl that the voice path
// will need to write events server-side via icloud-creds-link.
export async function discoverCalendarHome(
  email: string,
  password: string,
  userId: string,
): Promise<CalDavResult<{ calendarHomeUrl: string }>> {
  const res = await fullDiscover(email, password, userId);
  if (!res.ok) return res;
  return { ok: true, data: { calendarHomeUrl: res.data.calendarHomeUrl } };
}

// Reads the cached calendar list for the Settings "Stemmestyring" picker.
// Falls through to fullDiscover on cache miss so the picker doesn't
// silently render an empty list right after iCloud setup.
export async function getIcloudCalendars(
  userId: string,
): Promise<CalDavResult<IcloudCalendarMeta[]>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };

  let cache = await loadDiscoveryCache(userId, cred.credential.email);
  if (!cache || cache.calendars.length === 0) {
    const fresh = await fullDiscover(cred.credential.email, cred.credential.password, userId);
    if (!fresh.ok) {
      if (fresh.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
      return fresh;
    }
    cache = fresh.data;
  }
  return { ok: true, data: cache.calendars };
}

function basicAuth(email: string, password: string): string | null {
  // btoa throws on non-Latin-1 input. App-specific passwords are 16 lowercase
  // letters so this never bites in practice; setup-screen validation is the
  // primary defense. Returning null lets callers map this to 'auth-failed'.
  try {
    return 'Basic ' + btoa(`${email}:${password}`);
  } catch {
    return null;
  }
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
  if (__DEV__) console.log('[icloud-cal] listEvents start', {
    userId: userId.slice(0, 8), credKind: cred.kind,
    range: `${rangeStart.toISOString()} → ${rangeEnd.toISOString()}`,
  });
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };
  const auth = basicAuth(cred.credential.email, cred.credential.password);
  if (!auth) return { ok: false, error: 'auth-failed' };

  let cache = await loadDiscoveryCache(userId, cred.credential.email);
  const now = Date.now();
  // Treat an empty calendar list as cache invalid — the only way to get here
  // is a previous discovery that silently parsed 0 calendars. Forcing a fresh
  // discovery is the right move (and prevents an indefinitely-stuck zero state).
  if (cache && cache.calendars.length === 0) {
    if (__DEV__) console.log('[icloud-cal] cache had 0 calendars — forcing re-discovery');
    cache = null;
  }
  if (!cache || now - cache.principalDiscoveredAt > PRINCIPAL_TTL_MS) {
    if (__DEV__) console.log('[icloud-cal] cache miss → fullDiscover');
    const fresh = await fullDiscover(cred.credential.email, cred.credential.password, userId);
    if (!fresh.ok) {
      if (__DEV__) console.warn('[icloud-cal] fullDiscover failed:', fresh.error);
      if (fresh.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
      return fresh;
    }
    cache = fresh.data;
  } else if (now - cache.calendarsListedAt > CALENDAR_LIST_TTL_MS) {
    if (__DEV__) console.log('[icloud-cal] cache stale → re-listing calendars');
    const calsRes = await listCalendarsAt(cache.calendarHomeUrl, auth);
    if (!calsRes.ok) {
      if (__DEV__) console.warn('[icloud-cal] re-list failed:', calsRes.error);
      if (calsRes.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
      return calsRes;
    }
    cache = { ...cache, calendars: calsRes.data, calendarsListedAt: now };
    await saveDiscoveryCache(userId, cache);
  } else if (__DEV__) {
    console.log('[icloud-cal] cache hit', { calendars: cache.calendars.length });
  }

  // Fetch events from each calendar in parallel, capped at CONCURRENCY.
  const range = caldavTimeRange(rangeStart, rangeEnd);
  const cals = cache.calendars;
  if (__DEV__) console.log('[icloud-cal] fetching events from', cals.length, 'calendars',
    cals.map((c) => `${c.displayName ?? '?'} <${c.url}>`));
  // Re-bind with explicit type so the async worker closure below keeps the
  // string narrowing — TS un-narrows captured locals inside async functions.
  const authStr: string = auth;

  const results: IcloudCalEvent[] = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= cals.length) return;
      const cal = cals[i];
      const r = await reportEvents(cal.url, authStr, range);
      if (!r.ok) {
        // Per-calendar errors (including 401 on a non-event collection like
        // the schedule-inbox) are skipped, not fatal. Discovery-time auth
        // failures are the right signal for markInvalid; a single calendar
        // refusing the REPORT does not mean the credential rotated.
        if (__DEV__) console.warn('[icloud-cal] reportEvents failed', cal.displayName, r.error);
        continue;
      }
      let parsed = 0;
      for (const item of r.data) {
        const events = parseVcalendarEvents(item.data, rangeStart, rangeEnd, cal, item.href);
        parsed += events.length;
        results.push(...events);
      }
      if (__DEV__) console.log('[icloud-cal]', cal.displayName, 'returned', r.data.length, 'objects →', parsed, 'events');
      if (__DEV__ && r.data.length > 0 && parsed === 0) {
        console.warn('[icloud-cal] parser dropped all events for', cal.displayName,
          '— first 1500 chars of object[0]:', r.data[0].data.slice(0, 1500));
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, cals.length) }, () => worker());
  await Promise.all(workers);

  if (__DEV__) console.log('[icloud-cal] listEvents done — total events:', results.length);
  return { ok: true, data: results };
}

async function fullDiscover(
  email: string,
  password: string,
  userId: string,
): Promise<CalDavResult<CalDiscoveryCache>> {
  const auth = basicAuth(email, password);
  if (!auth) return { ok: false, error: 'auth-failed' };

  const principalRes = await propfindPrincipal(email, password);
  if (!principalRes.ok) return principalRes;
  const principalUrl = principalRes.data.principalUrl;

  const homeRes = await propfindCalendarHome(principalUrl, auth);
  if (!homeRes.ok) return homeRes;
  const calendarHomeUrl = homeRes.data.calendarHomeUrl;

  // Own calendars at the user's calendar-home.
  const ownCalsRes = await listCalendarsAt(calendarHomeUrl, auth);
  if (!ownCalsRes.ok) return ownCalsRes;
  if (__DEV__) console.log('[icloud-cal] discovered', ownCalsRes.data.length, 'own calendars',
    ownCalsRes.data.map((c) => c.displayName));

  // Shared/subscribed calendars: iCloud exposes them via
  // calendar-proxy-read-for / calendar-proxy-write-for collections on the
  // user's principal. Each href there points at ANOTHER user's calendar
  // collection (not their full calendar-home). We PROPFIND each as Depth:0
  // to read its display-name + color, then add it to the list.
  // Best-effort: if proxy enumeration fails we still return the user's own
  // calendars rather than blanking the calendar tab.
  const sharedCalsRes = await listSharedCalendars(principalUrl, auth);
  const allCalendars = sharedCalsRes.ok
    ? mergeCalendarsByUrl(ownCalsRes.data, sharedCalsRes.data)
    : ownCalsRes.data;
  if (__DEV__) {
    if (sharedCalsRes.ok) {
      console.log('[icloud-cal] discovered', sharedCalsRes.data.length, 'shared calendars',
        sharedCalsRes.data.map((c) => c.displayName));
    } else {
      console.warn('[icloud-cal] shared-calendar discovery failed:', sharedCalsRes.error);
    }
  }

  const cache: CalDiscoveryCache = {
    schema: DISCOVERY_SCHEMA,
    email,
    principalUrl,
    calendarHomeUrl,
    principalDiscoveredAt: Date.now(),
    calendars: allCalendars,
    calendarsListedAt: Date.now(),
  };
  await saveDiscoveryCache(userId, cache);
  return { ok: true, data: cache };
}

function mergeCalendarsByUrl(
  primary: IcloudCalendarMeta[],
  extras: IcloudCalendarMeta[],
): IcloudCalendarMeta[] {
  const seen = new Set(primary.map((c) => c.url));
  const merged = [...primary];
  for (const c of extras) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    merged.push(c);
  }
  return merged;
}

// PROPFIND principal Depth:0 for the proxy-for properties. Each property
// returns a list of hrefs to OTHER users' calendar collections shared with
// us. We then PROPFIND each Depth:0 to grab its displayname + color.
async function listSharedCalendars(
  principalUrl: string,
  auth: string,
): Promise<CalDavResult<IcloudCalendarMeta[]>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <cs:calendar-proxy-read-for/>
    <cs:calendar-proxy-write-for/>
  </d:prop>
</d:propfind>`;
  const res = await caldavFetch(principalUrl, 'PROPFIND', auth, { Depth: '0' }, body);
  if (!res.ok) return res;
  const sharedHrefs = new Set<string>();
  for (const propLocal of ['calendar-proxy-read-for', 'calendar-proxy-write-for']) {
    const propBlock = res.data.match(
      new RegExp(`<[^>]*${propLocal}[^>]*>([\\s\\S]*?)<\\/[^>]*${propLocal}[^>]*>`, 'i'),
    )?.[1] ?? '';
    for (const m of propBlock.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/gi)) {
      sharedHrefs.add(absolutize(m[1].trim()));
    }
  }
  if (sharedHrefs.size === 0) return { ok: true, data: [] };

  // Each href is another user's calendar collection. Probe each Depth:0 for
  // metadata. Concurrency cap reuses the existing CONCURRENCY constant.
  const hrefs = Array.from(sharedHrefs);
  const results: IcloudCalendarMeta[] = [];
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= hrefs.length) return;
      const meta = await propfindSharedCalendar(hrefs[i], auth);
      if (meta) results.push(meta);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, hrefs.length) }, () => worker()),
  );
  return { ok: true, data: results };
}

async function propfindSharedCalendar(
  url: string,
  auth: string,
): Promise<IcloudCalendarMeta | null> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <c:supported-calendar-component-set/>
    <x:calendar-color/>
  </d:prop>
</d:propfind>`;
  const res = await caldavFetch(url, 'PROPFIND', auth, { Depth: '0' }, body);
  if (!res.ok) return null;
  // The Depth:0 response wraps a single calendar in <response>. Reuse the
  // existing parser by feeding it the same XML — it'll return [meta] if the
  // calendar supports VEVENT, [] otherwise.
  const cals = parseCalendarList(res.data);
  if (cals.length === 0) return null;
  // parseCalendarList builds the URL from <href> in the response — for shared
  // calendars that href IS the calendar collection, so url = cals[0].url.
  return cals[0];
}

async function propfindPrincipal(
  email: string,
  password: string,
): Promise<CalDavResult<{ principalUrl: string }>> {
  const auth = basicAuth(email, password);
  if (!auth) return { ok: false, error: 'auth-failed' };
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;
  const res = await caldavFetch(
    `${CALDAV_HOST}/.well-known/caldav`,
    'PROPFIND',
    auth,
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
  // resourcetype is the strongest filter: iCloud's calendar-home returns the
  // home itself plus schedule-inbox/outbox under the same Depth:1 listing.
  // Only entries whose resourcetype contains <C:calendar/> are real calendars.
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
    <x:calendar-color/>
  </d:prop>
</d:propfind>`;
  const res = await caldavFetch(calendarHomeUrl, 'PROPFIND', auth, { Depth: '1' }, body);
  if (!res.ok) return res;
  const cals = parseCalendarList(res.data, calendarHomeUrl);
  if (__DEV__ && cals.length === 0) {
    console.warn('[icloud-cal] listCalendarsAt parsed 0 calendars; raw response (first 4000 chars):',
      res.data.slice(0, 4000));
  }
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

// iCloud responds with default-namespace XML (<response xmlns="DAV:">) rather
// than prefixed (<d:response>). Match either: optional `prefix:` ahead of the
// element name. The prior `:response` regex required a colon and silently
// returned 0 blocks against iCloud's payload.
const RESPONSE_OPEN_RE = /<(?:[a-z][\w-]*:)?response[^>]*>/i;
const RESPONSE_CLOSE_RE = /<\/(?:[a-z][\w-]*:)?response\s*>/i;

function parseCalendarList(xml: string, homeUrl?: string): IcloudCalendarMeta[] {
  const result: IcloudCalendarMeta[] = [];
  // Normalize the home URL once so per-block comparison is cheap.
  const homeAbs = homeUrl ? absolutize(homeUrl).replace(/\/?$/, '/') : null;
  const blocks = xml.split(RESPONSE_OPEN_RE).slice(1);
  for (const blockRaw of blocks) {
    const block = blockRaw.split(RESPONSE_CLOSE_RE)[0];
    const href = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i)?.[1]?.trim();
    if (!href) continue;
    const url = absolutize(href);
    // Belt-and-braces: skip the calendar-home itself if Apple includes it in
    // the Depth:1 listing without a calendar resourcetype.
    if (homeAbs && url.replace(/\/?$/, '/') === homeAbs) continue;
    // Only true calendar collections — filters out the home, schedule-inbox/
    // outbox, and any other non-calendar resources iCloud lumps into the
    // Depth:1 listing.
    const resourcetype = block.match(
      /<[^>]*resourcetype[^>]*>([\s\S]*?)<\/[^>]*resourcetype[^>]*>/i,
    )?.[1] ?? '';
    if (!/<[^>]*calendar[^>]*\/?>/i.test(resourcetype)) continue;
    const supports = block.match(
      /<[^>]*supported-calendar-component-set[^>]*>([\s\S]*?)<\/[^>]*supported-calendar-component-set[^>]*>/i,
    )?.[1] ?? '';
    if (!/<[^>]*comp[^>]*name=["']VEVENT["'][^>]*\/?>/i.test(supports)) continue;
    const displayName = block.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname[^>]*>/i)?.[1]?.trim() ?? '(uden navn)';
    const calendarColor = block.match(/<[^>]*calendar-color[^>]*>([^<]+)<\/[^>]*calendar-color[^>]*>/i)?.[1]?.trim();
    result.push({ url, displayName, calendarColor });
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALDAV_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/xml; charset=utf-8',
        // Apple's CalDAV edge servers throttle / silently drop requests
        // without a recognizable User-Agent — naked `fetch()` from RN
        // sends none, which iCloud treats as a bot. Identifying as an
        // iOS-flavored CalDAV client keeps the connection up.
        'User-Agent': 'Zolva/1.0 (iOS; CalDAV)',
        ...headers,
      },
      body,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    if (__DEV__) {
      const e = err as { name?: string; message?: string };
      console.warn(`[icloud-cal] ${method} ${url} threw:`, e?.name, e?.message);
    }
    return { ok: false, error: 'network' };
  }
  clearTimeout(timer);
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
  // Absolute URL of the .ics resource on the CalDAV server. Required for
  // PUT (update) and DELETE — events created elsewhere may not follow the
  // {calendarUrl}/{uid}.ics convention, so we don't try to reconstruct it.
  eventUrl: string;
  start: Date;
  end: Date;
  allDay: boolean;
  title: string;
  location?: string;
  description?: string;
  calendarColor?: string;
  calendarName: string;
  // URL of the calendar collection this event lives in — handy for the
  // chat tool layer when it needs to default new events to "the same
  // calendar this one is on".
  calendarUrl: string;
};

function caldavTimeRange(start: Date, end: Date): { start: string; end: string } {
  const fmt = (d: Date) =>
    d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { start: fmt(start), end: fmt(end) };
}

async function reportEvents(
  calendarUrl: string,
  auth: string,
  range: { start: string; end: string },
): Promise<CalDavResult<{ href: string; data: string }[]>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${range.start}" end="${range.end}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  const res = await caldavFetch(calendarUrl, 'REPORT', auth, { Depth: '1' }, body);
  if (!res.ok) return res;
  const items: { href: string; data: string }[] = [];
  // Walk per-<response> blocks so each calendar-data is paired with its
  // href — the href is what update/delete need to PUT/DELETE against.
  const responseBlocks = res.data.split(RESPONSE_OPEN_RE).slice(1);
  for (const blockRaw of responseBlocks) {
    const block = blockRaw.split(RESPONSE_CLOSE_RE)[0];
    const href = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i)?.[1]?.trim();
    if (!href) continue;
    const dataMatch = block.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data[^>]*>/i);
    if (!dataMatch) continue;
    let raw = dataMatch[1].trim();
    // iCloud wraps the iCalendar payload in <![CDATA[...]]>. Strip it before
    // handing to ICAL.parse — otherwise the leading "<![CDATA[" line fails
    // BEGIN:VCALENDAR validation and every event silently disappears.
    const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) raw = cdata[1].trim();
    raw = raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'");
    items.push({ href: absolutize(href), data: raw });
  }
  return { ok: true, data: items };
}

function parseVcalendarEvents(
  vcalText: string,
  rangeStart: Date,
  rangeEnd: Date,
  cal: IcloudCalendarMeta,
  eventUrl: string,
): IcloudCalEvent[] {
  let jcal: unknown;
  try { jcal = ICAL.parse(vcalText); }
  catch { return []; }
  const vcalendar = new ICAL.Component(jcal as [string, unknown[], unknown[]]);
  registerMissingTimezones(vcalendar);

  const out: IcloudCalEvent[] = [];
  for (const ve of vcalendar.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(ve);
    if (event.isRecurring()) {
      const iter = event.iterator();
      let next: ICAL.Time | null;
      while ((next = iter.next()) && next.toJSDate().getTime() < rangeEnd.getTime()) {
        if (next.toJSDate().getTime() < rangeStart.getTime()) continue;
        const details = event.getOccurrenceDetails(next);
        out.push(toIcloudEvent(details.item, details.startDate.toJSDate(), details.endDate.toJSDate(), cal, eventUrl));
      }
    } else {
      out.push(toIcloudEvent(event, event.startDate.toJSDate(), event.endDate.toJSDate(), cal, eventUrl));
    }
  }
  return out;
}

function toIcloudEvent(
  source: ICAL.Event,
  start: Date,
  end: Date,
  cal: IcloudCalendarMeta,
  eventUrl: string,
): IcloudCalEvent {
  return {
    uid: source.uid,
    eventUrl,
    start,
    end,
    allDay: !!source.startDate?.isDate,
    title: source.summary || '(uden titel)',
    location: source.location || undefined,
    description: source.description || undefined,
    calendarColor: cal.calendarColor,
    calendarName: cal.displayName,
    calendarUrl: cal.url,
  };
}

// VTIMEZONE fallback — when a VEVENT references TZID without an in-component
// VTIMEZONE block, register an Intl-DateTimeFormat-backed timezone so ical.js
// can resolve UTC offsets correctly. Without this, ical.js falls back to
// floating time → silent wrong-time bug for DST users.

function registerMissingTimezones(vcalendar: ICAL.Component): void {
  const referenced = new Set<string>();
  for (const ve of vcalendar.getAllSubcomponents('vevent')) {
    for (const propName of ['dtstart', 'dtend']) {
      const prop = ve.getFirstProperty(propName);
      const tzid = prop?.getParameter('tzid');
      if (typeof tzid === 'string') referenced.add(tzid);
    }
  }
  for (const tzid of referenced) {
    if (ICAL.TimezoneService.has(tzid)) continue;
    const present = vcalendar.getAllSubcomponents('vtimezone').some(
      (vtz) => vtz.getFirstPropertyValue('tzid') === tzid,
    );
    if (present) continue;
    const fallback = makeIntlTimezone(tzid);
    if (fallback) {
      ICAL.TimezoneService.register(tzid, fallback);
      if (__DEV__) {
        console.warn('[icloud-cal] VTIMEZONE missing for', tzid, '— Intl fallback');
      }
    }
  }
}

function makeIntlTimezone(tzid: string): ICAL.Timezone | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
  } catch {
    return null;
  }
  const probe = new Date();
  const offsetMin = -getIntlOffsetMinutes(tzid, probe);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const vtimezone = `BEGIN:VTIMEZONE
TZID:${tzid}
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:${sign}${hh}${mm}
TZOFFSETTO:${sign}${hh}${mm}
TZNAME:${tzid}
END:STANDARD
END:VTIMEZONE`;
  try {
    const j = ICAL.parse(`BEGIN:VCALENDAR\nVERSION:2.0\n${vtimezone}\nEND:VCALENDAR`);
    const c = new ICAL.Component(j as [string, unknown[], unknown[]]);
    const tz = new ICAL.Timezone(c.getFirstSubcomponent('vtimezone')!);
    return tz;
  } catch {
    return null;
  }
}

function getIntlOffsetMinutes(tzid: string, atDate: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    timeZoneName: 'shortOffset',
  });
  const parts = dtf.formatToParts(atDate);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const m = tzPart.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!m) return 0;
  const hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

// ─── Write surface (create / update / delete) ────────────────────────────
//
// All writes are HTTP PUT/DELETE against the event resource URL on
// caldav.icloud.com. iCloud's CalDAV is forgiving about minor formatting
// (CRLF/LF, line folding) but strict about: BEGIN/END pairing, UID, DTSTAMP,
// DTSTART, and a valid PRODID. We use ical.js to build the body so escaping
// of commas/semicolons/newlines in summary/description is handled correctly.

export type IcloudEventInput = {
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  location?: string;
  description?: string;
};

async function caldavWrite(
  url: string,
  method: 'PUT' | 'DELETE',
  auth: string,
  body: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<CalDavResult<null>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALDAV_TIMEOUT_MS);
  let res: Response;
  try {
    const headers: Record<string, string> = {
      Authorization: auth,
      'User-Agent': 'Zolva/1.0 (iOS; CalDAV)',
      ...extraHeaders,
    };
    if (body !== null) headers['Content-Type'] = 'text/calendar; charset=utf-8';
    res = await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      body: body ?? undefined,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    if (__DEV__) console.warn(`[icloud-cal] ${method} ${url} threw:`, (err as Error)?.message);
    return { ok: false, error: 'network' };
  }
  clearTimeout(timer);
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth-failed' };
  if (res.status === 404) return { ok: false, error: 'protocol' };
  // 412 Precondition Failed: If-None-Match: * caught a UID collision. Surface
  // as protocol — caller can retry with a freshly-generated UID.
  if (res.status === 412) return { ok: false, error: 'protocol' };
  if (res.status >= 200 && res.status < 300) return { ok: true, data: null };
  if (__DEV__) console.warn(`[icloud-cal] ${method} ${url} status ${res.status}`);
  return { ok: false, error: 'protocol' };
}

// iCalendar text values escape backslash, comma, semicolon, and newline. Per
// RFC 5545 §3.3.11 — control chars except TAB are not allowed; we drop them
// rather than fail. Lines should fold at 75 octets, but Apple's CalDAV is
// forgiving about long lines so we skip folding for simplicity.
function escapeIcsText(s: string): string {
  return s
    .replace(/[ --]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function fmtUtcDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function buildVeventIcs(input: { uid: string } & IcloudEventInput): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zolva//Zolva 1.0//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(input.uid)}`,
    `DTSTAMP:${fmtUtcDateTime(new Date())}`,
  ];
  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${fmtDate(input.start)}`);
    lines.push(`DTEND;VALUE=DATE:${fmtDate(input.end)}`);
  } else {
    lines.push(`DTSTART:${fmtUtcDateTime(input.start)}`);
    lines.push(`DTEND:${fmtUtcDateTime(input.end)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(input.title)}`);
  if (input.location) lines.push(`LOCATION:${escapeIcsText(input.location)}`);
  if (input.description) lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`);
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function generateUid(): string {
  // Hermes ≥ RN 0.74 / Apple's JSC both have crypto.randomUUID; fall back to
  // a coarse timestamp+random so a tooling drift doesn't take the feature
  // down. UID uniqueness is per-calendar; collisions are caught by the
  // If-None-Match precondition on PUT.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `${c.randomUUID()}@zolva.io`;
  const rand = Math.random().toString(36).slice(2);
  return `${Date.now()}-${rand}@zolva.io`;
}

async function resolveCalendarUrl(
  userId: string,
  email: string,
  password: string,
  hint?: string,
): Promise<{ ok: true; url: string } | { ok: false; error: CalDavErrorCode }> {
  let cache = await loadDiscoveryCache(userId, email);
  if (!cache || Date.now() - cache.principalDiscoveredAt > PRINCIPAL_TTL_MS) {
    const fresh = await fullDiscover(email, password, userId);
    if (!fresh.ok) return { ok: false, error: fresh.error };
    cache = fresh.data;
  }
  if (cache.calendars.length === 0) return { ok: false, error: 'protocol' };
  if (hint) {
    const matched = cache.calendars.find((c) => c.url === hint || c.displayName === hint);
    if (matched) return { ok: true, url: matched.url };
  }
  // Heuristic for "primary": iCloud's default calendar is usually called
  // "Hjem" (Danish locale) or the first own (non-shared) calendar in the
  // home collection. We don't have the own/shared flag here, so fall back
  // to the first calendar — matches the listEvents render order.
  return { ok: true, url: cache.calendars[0].url };
}

export async function createEvent(
  userId: string,
  input: IcloudEventInput & { calendarUrl?: string },
): Promise<CalDavResult<{ eventUrl: string; uid: string }>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };
  const auth = basicAuth(cred.credential.email, cred.credential.password);
  if (!auth) return { ok: false, error: 'auth-failed' };

  const calRes = await resolveCalendarUrl(
    userId, cred.credential.email, cred.credential.password, input.calendarUrl,
  );
  if (!calRes.ok) return calRes;

  const uid = generateUid();
  const ics = buildVeventIcs({ uid, ...input });
  const eventUrl = `${calRes.url.replace(/\/?$/, '/')}${encodeURIComponent(uid)}.ics`;

  // If-None-Match: * → server refuses if a resource already exists at this
  // URL (UID collision). Caller can regenerate UID and retry.
  const putRes = await caldavWrite(eventUrl, 'PUT', auth, ics, { 'If-None-Match': '*' });
  if (!putRes.ok) {
    if (putRes.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
    return { ok: false, error: putRes.error };
  }
  return { ok: true, data: { eventUrl, uid } };
}

export async function updateEvent(
  userId: string,
  eventUrl: string,
  input: IcloudEventInput & { uid: string },
): Promise<CalDavResult<null>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };
  const auth = basicAuth(cred.credential.email, cred.credential.password);
  if (!auth) return { ok: false, error: 'auth-failed' };

  const ics = buildVeventIcs(input);
  const r = await caldavWrite(eventUrl, 'PUT', auth, ics);
  if (!r.ok && r.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
  return r;
}

export async function deleteEvent(
  userId: string,
  eventUrl: string,
): Promise<CalDavResult<null>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };
  const auth = basicAuth(cred.credential.email, cred.credential.password);
  if (!auth) return { ok: false, error: 'auth-failed' };

  const r = await caldavWrite(eventUrl, 'DELETE', auth, null);
  if (!r.ok && r.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
  return r;
}

// Used by the chat tool layer to translate "icloud:<uid>" identifiers (which
// are all the model has after list_calendar_events) into the eventUrl needed
// by update/delete. Wide default range covers the typical "things I might
// edit" envelope: last 30 days through 6 months ahead.
export async function findEventByUid(
  userId: string,
  uid: string,
  rangeStart?: Date,
  rangeEnd?: Date,
): Promise<CalDavResult<IcloudCalEvent | null>> {
  const start = rangeStart ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = rangeEnd ?? new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
  const r = await listEvents(userId, start, end);
  if (!r.ok) return r;
  return { ok: true, data: r.data.find((e) => e.uid === uid) ?? null };
}
