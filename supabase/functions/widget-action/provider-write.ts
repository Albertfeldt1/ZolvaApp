import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  loadRefreshToken,
  refreshAccessToken,
  type Provider,
} from '../_shared/oauth.ts';

export type WriteOutcome =
  | { ok: true; eventId: string; eventUrl: string | null }
  | { ok: false; errorClass: 'oauth_invalid' }
  | { ok: false; errorClass: 'permission_denied'; calendarName: string }
  | { ok: false; errorClass: 'provider_5xx' };

const MICROSOFT_SCOPE = 'offline_access Calendars.ReadWrite';

export async function writeEvent(args: {
  client: SupabaseClient;
  userId: string;
  provider: Provider;
  calendarId: string;
  title: string;
  startIso: string;
  endIso: string;
  timezone: string;
}): Promise<WriteOutcome> {
  const refreshToken = await loadRefreshToken(args.client, args.userId, args.provider);
  if (!refreshToken) return { ok: false, errorClass: 'oauth_invalid' };

  let accessToken: string;
  try {
    const r = await refreshAccessToken(args.client, args.userId, args.provider, refreshToken, {
      microsoftScope: MICROSOFT_SCOPE,
    });
    accessToken = r.accessToken;
  } catch {
    return { ok: false, errorClass: 'oauth_invalid' };
  }

  // First attempt.
  const first = await postEvent(accessToken, args);
  if (first.kind === 'ok') return first.outcome;
  if (first.kind === 'error') return first.outcome;

  // 401 → refresh once and retry.
  let refreshedToken: string;
  try {
    const r = await refreshAccessToken(args.client, args.userId, args.provider, refreshToken, {
      microsoftScope: MICROSOFT_SCOPE,
    });
    refreshedToken = r.accessToken;
  } catch {
    return { ok: false, errorClass: 'oauth_invalid' };
  }

  const second = await postEvent(refreshedToken, args);
  if (second.kind === 'ok') return second.outcome;
  if (second.kind === 'error') return second.outcome;
  // Second 401 → token genuinely rejected.
  return { ok: false, errorClass: 'oauth_invalid' };
}

type AttemptResult =
  | { kind: 'ok'; outcome: WriteOutcome }
  | { kind: 'error'; outcome: WriteOutcome }
  | { kind: 'unauthorized' };

async function postEvent(
  token: string,
  args: { provider: Provider; calendarId: string; title: string; startIso: string; endIso: string; timezone: string },
): Promise<AttemptResult> {
  if (args.provider === 'google') return postGoogle(token, args);
  return postMicrosoft(token, args);
}

async function postGoogle(
  token: string,
  args: { calendarId: string; title: string; startIso: string; endIso: string; timezone: string },
): Promise<AttemptResult> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendarId)}/events`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: args.title,
      start: { dateTime: args.startIso, timeZone: args.timezone },
      end: { dateTime: args.endIso, timeZone: args.timezone },
    }),
  });
  if (res.status === 401) return { kind: 'unauthorized' };
  if (res.status === 403) {
    const name = await lookupGoogleCalendarName(token, args.calendarId).catch(() => args.calendarId);
    return { kind: 'error', outcome: { ok: false, errorClass: 'permission_denied', calendarName: name } };
  }
  if (res.status >= 500) return { kind: 'error', outcome: { ok: false, errorClass: 'provider_5xx' } };
  if (!res.ok) return { kind: 'error', outcome: { ok: false, errorClass: 'provider_5xx' } };
  const body = await res.json() as { id: string; htmlLink?: string };
  return {
    kind: 'ok',
    outcome: { ok: true, eventId: body.id, eventUrl: body.htmlLink ?? null },
  };
}

async function postMicrosoft(
  token: string,
  args: { calendarId: string; title: string; startIso: string; endIso: string; timezone: string },
): Promise<AttemptResult> {
  const url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(args.calendarId)}/events`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: args.title,
      start: { dateTime: stripOffset(args.startIso), timeZone: args.timezone },
      end: { dateTime: stripOffset(args.endIso), timeZone: args.timezone },
    }),
  });
  if (res.status === 401) return { kind: 'unauthorized' };
  if (res.status === 403) {
    const name = await lookupMicrosoftCalendarName(token, args.calendarId).catch(() => args.calendarId);
    return { kind: 'error', outcome: { ok: false, errorClass: 'permission_denied', calendarName: name } };
  }
  if (res.status >= 500) return { kind: 'error', outcome: { ok: false, errorClass: 'provider_5xx' } };
  if (!res.ok) return { kind: 'error', outcome: { ok: false, errorClass: 'provider_5xx' } };
  const body = await res.json() as { id: string; webLink?: string };
  return {
    kind: 'ok',
    outcome: { ok: true, eventId: body.id, eventUrl: body.webLink ?? null },
  };
}

// Microsoft Graph rejects ISO strings that include a UTC offset on the
// dateTime field — it wants naive local time + a separate timeZone field.
function stripOffset(iso: string): string {
  return iso.replace(/(?:Z|[+\-]\d{2}:?\d{2})$/, '');
}

async function lookupGoogleCalendarName(token: string, calendarId: string): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return calendarId;
  const body = await res.json() as { summary?: string; summaryOverride?: string };
  return body.summaryOverride ?? body.summary ?? calendarId;
}

async function lookupMicrosoftCalendarName(token: string, calendarId: string): Promise<string> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return calendarId;
  const body = await res.json() as { name?: string };
  return body.name ?? calendarId;
}
