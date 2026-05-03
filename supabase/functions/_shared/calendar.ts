// Server-side "fetch today's events" aggregator for the daily brief.
//
// Multi-provider, multi-calendar. For each connected provider in
// user_oauth_tokens, enumerate the user's calendarList, filter by
// user_calendar_preferences (absent row = include), skip provider-native
// hide signals (Google selected===false, Microsoft isHidden===true), and
// fetch events from each remaining calendar in parallel with a per-calendar
// timeout. Merge across providers, sort by start, return the next MAX_EVENTS.
//
// Day-boundary logic uses Intl.DateTimeFormat with an IANA timezone so DST
// transitions are handled correctly. Running at 23:59 Copenhagen returns
// today's events; at 00:01 returns the new day's events.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  loadRefreshToken,
  refreshAccessToken,
  type Provider,
} from './oauth.ts';

export type EventSummary = {
  title: string;
  startIso: string;
  endIso: string;
  location?: string;
  allDay?: boolean;
};

const CALENDAR_TIMEOUT_MS = 3000;
const MAX_EVENTS = 10;
const CALENDAR_PROVIDERS: ReadonlyArray<Provider> = ['google', 'microsoft'];

type CalendarMeta = {
  id: string;
  name: string;
  // Google: selected===false means user unchecked it in the Google Calendar
  // UI. Skip those even when prefs row is absent.
  googleSelected?: boolean;
  // Microsoft: isHidden===true means user hid it in Outlook. Skip those.
  microsoftHidden?: boolean;
};

type PrefsMap = Map<string, boolean>; // key: `${provider}:${calendarId}` -> included

export async function fetchCalendarForUser(
  client: SupabaseClient,
  userId: string,
  timezone: string,
): Promise<EventSummary[]> {
  const [providers, prefs] = await Promise.all([
    findConnectedProviders(client, userId),
    loadCalendarPrefs(client, userId),
  ]);
  if (providers.length === 0) return [];

  const settled = await Promise.allSettled(
    providers.map((p) => fetchProviderEvents(client, userId, p, timezone, prefs)),
  );

  const events: EventSummary[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') events.push(...r.value);
  }
  events.sort((a, b) => a.startIso.localeCompare(b.startIso));
  return events.slice(0, MAX_EVENTS);
}

async function findConnectedProviders(
  client: SupabaseClient,
  userId: string,
): Promise<Provider[]> {
  const { data, error } = await client
    .from('user_oauth_tokens')
    .select('provider')
    .eq('user_id', userId)
    .in('provider', CALENDAR_PROVIDERS as unknown as string[]);
  if (error) {
    console.warn(`[calendar] provider lookup failed user=${userId}:`, error.message);
    return [];
  }
  const seen = new Set<Provider>();
  for (const row of data ?? []) {
    const p = (row as { provider?: Provider }).provider;
    if (p === 'google' || p === 'microsoft') seen.add(p);
  }
  return Array.from(seen);
}

async function loadCalendarPrefs(
  client: SupabaseClient,
  userId: string,
): Promise<PrefsMap> {
  const map: PrefsMap = new Map();
  const { data, error } = await client
    .from('user_calendar_preferences')
    .select('provider, calendar_id, included')
    .eq('user_id', userId);
  if (error) {
    // Fall back to "include everything" — better to over-include than to
    // silently produce an empty brief because the prefs query failed.
    console.warn(`[calendar] prefs lookup failed user=${userId}:`, error.message);
    return map;
  }
  for (const row of data ?? []) {
    const r = row as { provider?: string; calendar_id?: string; included?: boolean };
    if (!r.provider || !r.calendar_id) continue;
    map.set(`${r.provider}:${r.calendar_id}`, r.included !== false);
  }
  return map;
}

async function fetchProviderEvents(
  client: SupabaseClient,
  userId: string,
  provider: Provider,
  timezone: string,
  prefs: PrefsMap,
): Promise<EventSummary[]> {
  const refreshToken = await loadRefreshToken(client, userId, provider);
  if (!refreshToken) return [];

  let accessToken: string;
  try {
    const result = await refreshAccessToken(client, userId, provider, refreshToken, {
      microsoftScope: 'offline_access Calendars.Read',
    });
    accessToken = result.accessToken;
  } catch (err) {
    console.warn(`[calendar] refresh failed user=${userId} provider=${provider}:`, err);
    return [];
  }

  let calendars: CalendarMeta[];
  try {
    calendars = provider === 'google'
      ? await listGoogleCalendars(accessToken)
      : await listMicrosoftCalendars(accessToken);
  } catch (err) {
    console.warn(`[calendar] list failed user=${userId} provider=${provider}:`, err);
    return [];
  }

  const visible = calendars.filter((c) => isCalendarVisible(provider, c, prefs));
  if (visible.length === 0) return [];

  const { startIso, endIso } = getDayBoundsUTC(new Date(), timezone);

  const settled = await Promise.allSettled(
    visible.map((cal) =>
      withTimeout(
        provider === 'google'
          ? fetchGoogleCalendarEvents(accessToken, cal.id, startIso, endIso, timezone, userId)
          : fetchMicrosoftCalendarEvents(accessToken, cal.id, startIso, endIso, timezone, userId),
        CALENDAR_TIMEOUT_MS,
        () => `${provider}:${cal.id}`,
      ),
    ),
  );

  const events: EventSummary[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      events.push(...r.value);
    } else {
      const cal = visible[i];
      console.warn(
        `[calendar] fetch failed user=${userId} provider=${provider} calendarId=${cal.id} name=${cal.name}:`,
        r.reason,
      );
    }
  }
  return events;
}

function isCalendarVisible(provider: Provider, cal: CalendarMeta, prefs: PrefsMap): boolean {
  const pref = prefs.get(`${provider}:${cal.id}`);
  if (pref === false) return false;
  if (provider === 'google' && cal.googleSelected === false) return false;
  if (provider === 'microsoft' && cal.microsoftHidden === true) return false;
  return true;
}

async function listGoogleCalendars(accessToken: string): Promise<CalendarMeta[]> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&fields=items(id,summary,selected,primary)',
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`google calendarList ${res.status}`);
  const data = (await res.json()) as {
    items?: Array<{ id?: string; summary?: string; selected?: boolean; primary?: boolean }>;
  };
  return (data.items ?? []).flatMap((c) => {
    if (!c.id) return [];
    return [{
      id: c.id,
      name: c.summary ?? c.id,
      // Google's `selected` field is undefined on `primary` calendars — treat
      // undefined as "user has it visible" (default-on).
      googleSelected: c.selected,
    }];
  });
}

async function listMicrosoftCalendars(accessToken: string): Promise<CalendarMeta[]> {
  // $select narrows the payload; $top avoids paginating for users with many
  // shared calendars (defaulting to first 50 is fine for v1).
  const url =
    'https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,isHidden,isDefaultCalendar&$top=50';
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`graph calendars ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{ id?: string; name?: string; isHidden?: boolean }>;
  };
  return (data.value ?? []).flatMap((c) => {
    if (!c.id) return [];
    return [{
      id: c.id,
      name: c.name ?? c.id,
      microsoftHidden: c.isHidden,
    }];
  });
}

async function fetchGoogleCalendarEvents(
  accessToken: string,
  calendarId: string,
  startIso: string,
  endIso: string,
  timezone: string,
  userId: string,
): Promise<EventSummary[]> {
  const params = new URLSearchParams({
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
    timeZone: timezone,
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`google calendar ${res.status}`);
  const data = (await res.json()) as {
    items?: Array<{
      id?: string;
      summary?: string;
      location?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
  };
  // Events crossing midnight: singleEvents expansion gives us a single row
  // with its true start/end; formatting shows end-time as local HH:mm, which
  // reads as a very long meeting. Acceptable for v1.
  return (data.items ?? []).flatMap((e) => {
    const startIsoRaw = e.start?.dateTime ?? e.start?.date;
    const endIsoRaw = e.end?.dateTime ?? e.end?.date;
    if (!startIsoRaw || !endIsoRaw) {
      console.warn('[calendar] dropping event', {
        userId,
        provider: 'google',
        calendarId,
        eventId: e.id ?? 'unknown',
        reason: 'missing_start_or_end',
      });
      return [];
    }
    return [{
      title: (e.summary ?? '').trim() || 'Møde uden titel',
      startIso: startIsoRaw,
      endIso: endIsoRaw,
      location: e.location || undefined,
      allDay: !!e.start?.date && !e.start?.dateTime,
    }];
  });
}

async function fetchMicrosoftCalendarEvents(
  accessToken: string,
  calendarId: string,
  startIso: string,
  endIso: string,
  timezone: string,
  userId: string,
): Promise<EventSummary[]> {
  const params = new URLSearchParams({
    startDateTime: startIso,
    endDateTime: endIso,
    $orderby: 'start/dateTime',
    $top: '50',
  });
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${params.toString()}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        Prefer: `outlook.timezone="${timezone}"`,
      },
    },
  );
  if (!res.ok) throw new Error(`microsoft calendar ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{
      id?: string;
      subject?: string;
      location?: { displayName?: string };
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      isAllDay?: boolean;
    }>;
  };
  // Events crossing midnight: Graph returns the event once; v1 displays the
  // local end-time as HH:mm even for 23:00–01:00-type ranges. Acceptable.
  return (data.value ?? []).flatMap((e) => {
    const startIsoRaw = e.start?.dateTime;
    const endIsoRaw = e.end?.dateTime;
    if (!startIsoRaw || !endIsoRaw) {
      console.warn('[calendar] dropping event', {
        userId,
        provider: 'microsoft',
        calendarId,
        eventId: e.id ?? 'unknown',
        reason: 'missing_start_or_end',
      });
      return [];
    }
    return [{
      title: (e.subject ?? '').trim() || 'Møde uden titel',
      startIso: startIsoRaw,
      endIso: endIsoRaw,
      location: e.location?.displayName || undefined,
      allDay: !!e.isAllDay,
    }];
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: () => string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms (${label()})`)), ms),
    ),
  ]);
}

// Returns { startIso, endIso } where both are UTC Zulu timestamps representing
// the local midnight boundaries for `timezone` on "now's" local date.
function getDayBoundsUTC(now: Date, timezone: string): { startIso: string; endIso: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  const startIso = offsetAwareUtc(`${y}-${m}-${d}T00:00:00`, timezone);
  const endIso = offsetAwareUtc(`${y}-${m}-${d}T23:59:59`, timezone);
  return { startIso, endIso };
}

// Convert a local wall-clock string ("2026-04-23T00:00:00") in `timezone` to
// a UTC ISO string. Uses Intl to read back the local hour, then adjusts.
function offsetAwareUtc(localNoTz: string, timezone: string): string {
  const asIfUtc = new Date(`${localNoTz}Z`);
  const localParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(asIfUtc);
  const y = +localParts.find((p) => p.type === 'year')!.value;
  const mo = +localParts.find((p) => p.type === 'month')!.value;
  const d = +localParts.find((p) => p.type === 'day')!.value;
  const h = +localParts.find((p) => p.type === 'hour')!.value;
  const mi = +localParts.find((p) => p.type === 'minute')!.value;
  const s = +localParts.find((p) => p.type === 'second')!.value;
  const localAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const diffMs = localAsUtc - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - diffMs).toISOString();
}
