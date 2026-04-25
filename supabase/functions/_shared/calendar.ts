// Server-side "fetch today's events" helpers for Google Calendar + Microsoft
// Graph. Produces events in the shape the daily-brief composer expects.
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

export async function fetchCalendarForUser(
  client: SupabaseClient,
  userId: string,
  timezone: string,
): Promise<EventSummary[]> {
  const provider = await pickCalendarProvider(client, userId);
  if (!provider) return [];

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

  const fetcher = provider === 'google'
    ? fetchGoogleCalendarToday(accessToken, timezone, userId)
    : fetchMicrosoftCalendarToday(accessToken, timezone, userId);

  try {
    const events = await Promise.race([
      fetcher,
      new Promise<EventSummary[]>((_, reject) =>
        setTimeout(() => reject(new Error('calendar timeout')), CALENDAR_TIMEOUT_MS),
      ),
    ]);
    return events.slice(0, MAX_EVENTS);
  } catch (err) {
    console.warn(`[calendar] fetch failed user=${userId} provider=${provider}:`, err);
    return [];
  }
}

// If both providers are linked, prefer the most recently updated one.
async function pickCalendarProvider(
  client: SupabaseClient,
  userId: string,
): Promise<Provider | null> {
  const { data, error } = await client
    .from('user_oauth_tokens')
    .select('provider, updated_at')
    .eq('user_id', userId)
    .in('provider', ['google', 'microsoft'])
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('[calendar] provider lookup failed:', error.message);
    return null;
  }
  const row = (data ?? [])[0] as { provider?: Provider } | undefined;
  return row?.provider ?? null;
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
  // Parse as UTC, then nudge by the offset Intl reports for that instant.
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

async function fetchGoogleCalendarToday(
  accessToken: string,
  timezone: string,
  userId: string,
): Promise<EventSummary[]> {
  const { startIso, endIso } = getDayBoundsUTC(new Date(), timezone);
  const params = new URLSearchParams({
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
    timeZone: timezone,
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
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

async function fetchMicrosoftCalendarToday(
  accessToken: string,
  timezone: string,
  userId: string,
): Promise<EventSummary[]> {
  const { startIso, endIso } = getDayBoundsUTC(new Date(), timezone);
  const params = new URLSearchParams({
    startDateTime: startIso,
    endDateTime: endIso,
    $orderby: 'start/dateTime',
    $top: '50',
  });
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarview?${params.toString()}`,
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
