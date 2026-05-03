// supabase/functions/_shared/icloud-calendar.ts
//
// Server-side iCloud CalDAV reader for the daily brief. Mirrors
// src/lib/icloud-calendar.ts but trimmed for the cron-driven server flow.
//
// Differences from the client:
//   - calendar_home_url is already discovered + persisted by
//     icloud-creds-link, so we skip the principal/home PROPFIND chain.
//   - No discovery cache. Runs once per cron tick per user.
//   - Asks iCloud for server-side recurrence expansion via <C:expand>.
//     If iCloud honors it, ical.js sees pre-expanded instances and
//     skips the iterator path. If iCloud returns RRULE anyway, ical.js
//     expands locally — same code path the client runs in production.
//   - On any non-recoverable error (creds missing, auth-failed, network)
//     returns [] silently. Daily-brief skips iCloud for that user; the
//     client surfaces re-entry on next app open via icloud-credentials.ts.
//
// Hardcoded include-all: no user_calendar_preferences read for iCloud
// in v1. The picker session adds the migration + the prefs read.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import ICAL from 'https://esm.sh/ical.js@2';
import { loadIcloudCreds } from './icloud-creds.ts';
import type { EventSummary } from './calendar.ts';

const CALDAV_TIMEOUT_MS = 4000;
const CALDAV_USER_AGENT = 'Zolva/1.0 (server; CalDAV)';
// Hard cap on RRULE iterations per VEVENT — defensive against pathological
// rules (e.g. FREQ=SECONDLY) that would otherwise spin the function.
const MAX_OCCURRENCES_PER_EVENT = 200;

// Quick existence check used by _shared/calendar.ts to decide whether to
// run the iCloud branch at all. Avoids a wasted decrypt call for users
// who never connected iCloud.
export async function userHasIcloudCreds(
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { count, error } = await client
    .from('user_icloud_calendar_creds')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) {
    console.warn(`[icloud-cal] creds existence check failed user=${userId.slice(0, 8)}:`, error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

export async function fetchIcloudEvents(
  client: SupabaseClient,
  userId: string,
  timezone: string,
  encryptionKey: string,
  startUtcIso: string,
  endUtcIso: string,
): Promise<EventSummary[]> {
  const creds = await loadIcloudCreds(client, userId, encryptionKey);
  if (!creds) return [];

  const auth = basicAuth(creds.email, creds.password);
  if (!auth) return [];

  const calendars = await listCalendarsAt(creds.calendar_home_url, auth, userId);
  if (calendars.length === 0) return [];

  const range = {
    start: isoToCaldavTs(startUtcIso),
    end: isoToCaldavTs(endUtcIso),
  };

  const settled = await Promise.allSettled(
    calendars.map((cal) =>
      withCalDavTimeout(
        reportEvents(cal.url, auth, range),
        () => `icloud:${cal.displayName}`,
      ),
    ),
  );

  const events: EventSummary[] = [];
  const startMs = new Date(startUtcIso).getTime();
  const endMs = new Date(endUtcIso).getTime();

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') {
      console.warn(
        `[icloud-cal] fetch failed user=${userId.slice(0, 8)} calendar=${calendars[i].displayName}:`,
        r.reason,
      );
      continue;
    }
    for (const item of r.value) {
      events.push(...parseVcalendarEvents(item.data, startMs, endMs, timezone, userId));
    }
  }
  return events;
}

// ─── HTTP helpers ───────────────────────────────────────────────────

function basicAuth(email: string, password: string): string | null {
  try {
    return 'Basic ' + btoa(`${email}:${password}`);
  } catch {
    return null;
  }
}

type CalDavOk = { ok: true; data: string };
type CalDavErr = { ok: false; error: 'auth-failed' | 'network' | 'timeout' | 'protocol' };
type CalDavResult = CalDavOk | CalDavErr;

async function caldavFetch(
  url: string,
  method: string,
  auth: string,
  headers: Record<string, string>,
  body: string,
): Promise<CalDavResult> {
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
        'User-Agent': CALDAV_USER_AGENT,
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
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth-failed' };
  if (res.status === 207 || res.status === 200) return { ok: true, data: await res.text() };
  return { ok: false, error: 'protocol' };
}

function withCalDavTimeout<T>(p: Promise<T>, label: () => string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`timeout ${CALDAV_TIMEOUT_MS}ms (${label()})`)),
        CALDAV_TIMEOUT_MS,
      ),
    ),
  ]);
}

// ─── Calendar list ───────────────────────────────────────────────────

type IcloudCalendarMeta = { url: string; displayName: string };

const RESPONSE_OPEN_RE = /<(?:[a-z][\w-]*:)?response[^>]*>/i;
const RESPONSE_CLOSE_RE = /<\/(?:[a-z][\w-]*:)?response\s*>/i;

async function listCalendarsAt(
  homeUrl: string,
  auth: string,
  userId: string,
): Promise<IcloudCalendarMeta[]> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;
  const res = await caldavFetch(homeUrl, 'PROPFIND', auth, { Depth: '1' }, body);
  if (!res.ok) {
    console.warn(`[icloud-cal] PROPFIND home failed user=${userId.slice(0, 8)}: ${res.error}`);
    return [];
  }
  return parseCalendarList(res.data, homeUrl);
}

function parseCalendarList(xml: string, homeUrl: string): IcloudCalendarMeta[] {
  const result: IcloudCalendarMeta[] = [];
  const homeAbs = absolutize(homeUrl, homeUrl).replace(/\/?$/, '/');
  const blocks = xml.split(RESPONSE_OPEN_RE).slice(1);
  for (const blockRaw of blocks) {
    const block = blockRaw.split(RESPONSE_CLOSE_RE)[0];
    const href = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i)?.[1]?.trim();
    if (!href) continue;
    const url = absolutize(href, homeUrl);
    // Skip the calendar-home itself if iCloud lists it without a calendar resourcetype.
    if (url.replace(/\/?$/, '/') === homeAbs) continue;
    const resourcetype = block.match(
      /<[^>]*resourcetype[^>]*>([\s\S]*?)<\/[^>]*resourcetype[^>]*>/i,
    )?.[1] ?? '';
    if (!/<[^>]*calendar[^>]*\/?>/i.test(resourcetype)) continue;
    const supports = block.match(
      /<[^>]*supported-calendar-component-set[^>]*>([\s\S]*?)<\/[^>]*supported-calendar-component-set[^>]*>/i,
    )?.[1] ?? '';
    if (!/<[^>]*comp[^>]*name=["']VEVENT["'][^>]*\/?>/i.test(supports)) continue;
    const displayName = block.match(
      /<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname[^>]*>/i,
    )?.[1]?.trim() ?? '(uden navn)';
    result.push({ url, displayName });
  }
  return result;
}

// CalDAV hrefs come back as either absolute (https://…) or path-only (/…).
// Resolve against the calendar-home origin since that's the canonical iCloud
// host (p123-caldav.icloud.com varies per user).
function absolutize(maybeRelative: string, homeUrl: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  try {
    const home = new URL(homeUrl);
    if (maybeRelative.startsWith('/')) return `${home.origin}${maybeRelative}`;
    return `${home.origin}/${maybeRelative}`;
  } catch {
    return maybeRelative;
  }
}

// ─── Events ──────────────────────────────────────────────────────────

type CalDataItem = { href: string; data: string };

async function reportEvents(
  calendarUrl: string,
  auth: string,
  range: { start: string; end: string },
): Promise<CalDataItem[]> {
  // <C:expand> asks the server for expanded recurrence instances within the
  // range. iCloud usually honors it. If not, ical.js's iterator handles RRULE
  // locally during parse — see parseVcalendarEvents.
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <c:calendar-data>
      <c:expand start="${range.start}" end="${range.end}"/>
    </c:calendar-data>
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
  if (!res.ok) throw new Error(`REPORT ${calendarUrl}: ${res.error}`);

  const items: CalDataItem[] = [];
  const blocks = res.data.split(RESPONSE_OPEN_RE).slice(1);
  for (const blockRaw of blocks) {
    const block = blockRaw.split(RESPONSE_CLOSE_RE)[0];
    const href = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i)?.[1]?.trim();
    if (!href) continue;
    const dataMatch = block.match(
      /<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data[^>]*>/i,
    );
    if (!dataMatch) continue;
    let raw = dataMatch[1].trim();
    // iCloud sometimes wraps the iCalendar payload in <![CDATA[...]]>.
    const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) raw = cdata[1].trim();
    raw = raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'");
    items.push({ href, data: raw });
  }
  return items;
}

// ─── Parsing ─────────────────────────────────────────────────────────

function parseVcalendarEvents(
  vcalText: string,
  startMs: number,
  endMs: number,
  timezone: string,
  userId: string,
): EventSummary[] {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(vcalText);
  } catch (err) {
    console.warn(`[icloud-cal] ICAL.parse failed user=${userId.slice(0, 8)}:`, String(err).slice(0, 200));
    return [];
  }
  let vcal: ICAL.Component;
  try {
    vcal = new ICAL.Component(jcal as [string, unknown[], unknown[]]);
  } catch {
    return [];
  }
  registerMissingTimezones(vcal, timezone);

  const out: EventSummary[] = [];
  for (const ve of vcal.getAllSubcomponents('vevent')) {
    let event: ICAL.Event;
    try {
      event = new ICAL.Event(ve);
    } catch {
      continue;
    }
    if (event.isRecurring()) {
      let iter: ICAL.RecurExpansion;
      try {
        iter = event.iterator();
      } catch {
        continue;
      }
      let next: ICAL.Time | null;
      let safety = MAX_OCCURRENCES_PER_EVENT;
      while ((next = iter.next()) && safety-- > 0) {
        const startD = next.toJSDate();
        const t = startD.getTime();
        if (t >= endMs) break;
        if (t < startMs) continue;
        try {
          const details = event.getOccurrenceDetails(next);
          out.push(toSummary(details.item, details.startDate.toJSDate(), details.endDate.toJSDate()));
        } catch {
          continue;
        }
      }
    } else {
      const startD = event.startDate?.toJSDate?.();
      const endD = event.endDate?.toJSDate?.();
      if (!startD || !endD) continue;
      const t = startD.getTime();
      if (t < startMs || t >= endMs) continue;
      out.push(toSummary(event, startD, endD));
    }
  }
  return out;
}

function toSummary(source: ICAL.Event, start: Date, end: Date): EventSummary {
  const isAllDay = !!source.startDate?.isDate;
  return {
    title: (source.summary ?? '').trim() || 'Møde uden titel',
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    location: source.location || undefined,
    allDay: isAllDay,
  };
}

// ─── Timezone fallback ───────────────────────────────────────────────
//
// When a VEVENT references TZID without an inline VTIMEZONE block (and
// ical.js doesn't already know the zone), register an Intl-backed
// fallback so DST users don't get silent wrong-time bugs.

function registerMissingTimezones(vcal: ICAL.Component, defaultTz: string): void {
  const referenced = new Set<string>();
  for (const ve of vcal.getAllSubcomponents('vevent')) {
    for (const propName of ['dtstart', 'dtend']) {
      const prop = ve.getFirstProperty(propName);
      const tzid = prop?.getParameter?.('tzid');
      if (typeof tzid === 'string') referenced.add(tzid);
    }
  }
  // Always make the user's locale TZ resolvable too — covers floating-time
  // events that need to be interpreted in the user's timezone.
  referenced.add(defaultTz);
  for (const tzid of referenced) {
    if (ICAL.TimezoneService.has(tzid)) continue;
    const inline = vcal.getAllSubcomponents('vtimezone').some(
      (vtz) => vtz.getFirstPropertyValue('tzid') === tzid,
    );
    if (inline) continue;
    const fallback = makeIntlTimezone(tzid);
    if (fallback) ICAL.TimezoneService.register(tzid, fallback);
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
    return new ICAL.Timezone(c.getFirstSubcomponent('vtimezone')!);
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

// ─── Misc ────────────────────────────────────────────────────────────

// 2026-05-04T00:00:00.000Z → 20260504T000000Z (CalDAV time-range format).
function isoToCaldavTs(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
