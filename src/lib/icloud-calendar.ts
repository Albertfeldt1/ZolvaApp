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

type CalDiscoveryCache = {
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
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };
  const auth = basicAuth(cred.credential.email, cred.credential.password);
  if (!auth) return { ok: false, error: 'auth-failed' };

  let cache = await loadDiscoveryCache(userId, cred.credential.email);
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

  // Fetch events from each calendar in parallel, capped at CONCURRENCY.
  const range = caldavTimeRange(rangeStart, rangeEnd);
  const cals = cache.calendars;
  // Re-bind with explicit type so the async worker closure below keeps the
  // string narrowing — TS un-narrows captured locals inside async functions.
  const authStr: string = auth;

  const results: IcloudCalEvent[] = [];
  let nextIndex = 0;
  let firstFatalError: CalDavErrorCode | null = null;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= cals.length) return;
      const cal = cals[i];
      const r = await reportEvents(cal.url, authStr, range);
      if (!r.ok) {
        if (r.error === 'auth-failed' && firstFatalError == null) firstFatalError = 'auth-failed';
        // Other errors: skip this calendar (best-effort) — partial result preferred.
        continue;
      }
      for (const raw of r.data) {
        const events = parseVcalendarEvents(raw, rangeStart, rangeEnd, cal);
        results.push(...events);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, cals.length) }, () => worker());
  await Promise.all(workers);

  if (firstFatalError === 'auth-failed') {
    await markInvalid(userId, 'caldav-rejected');
    return { ok: false, error: 'auth-failed' };
  }

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

  const calsRes = await listCalendarsAt(calendarHomeUrl, auth);
  if (!calsRes.ok) return calsRes;

  const cache: CalDiscoveryCache = {
    email,
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
        ...headers,
      },
      body,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
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
  start: Date;
  end: Date;
  allDay: boolean;
  title: string;
  location?: string;
  description?: string;
  calendarColor?: string;
  calendarName: string;
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
): Promise<CalDavResult<string[]>> {
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
  const blocks: string[] = [];
  for (const m of res.data.matchAll(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data[^>]*>/gi)) {
    blocks.push(m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim());
  }
  return { ok: true, data: blocks };
}

function parseVcalendarEvents(
  vcalText: string,
  rangeStart: Date,
  rangeEnd: Date,
  cal: IcloudCalendarMeta,
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
        out.push(toIcloudEvent(details.item, details.startDate.toJSDate(), details.endDate.toJSDate(), cal));
      }
    } else {
      out.push(toIcloudEvent(event, event.startDate.toJSDate(), event.endDate.toJSDate(), cal));
    }
  }
  return out;
}

function toIcloudEvent(
  source: ICAL.Event,
  start: Date,
  end: Date,
  cal: IcloudCalendarMeta,
): IcloudCalEvent {
  return {
    uid: source.uid,
    start,
    end,
    allDay: !!source.startDate?.isDate,
    title: source.summary || '(uden titel)',
    location: source.location || undefined,
    description: source.description || undefined,
    calendarColor: cal.calendarColor,
    calendarName: cal.displayName,
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
