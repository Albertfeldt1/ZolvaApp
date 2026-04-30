// supabase/functions/_shared/backfill-providers/microsoft-calendar.ts

import type { CalendarSeries } from '../onboarding-backfill.ts';
import { fetchWithRetry } from '../onboarding-backfill.ts';

const BASE = 'https://graph.microsoft.com/v1.0';

const SKIP_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^lunch$/i,
  /^frokost$/i,
  /^coffee$/i,
  /^kaffe$/i,
  /^1:1$/i,
  /^pause$/i,
  /^standup$/i,
];

export async function fetchGraphRecurring(
  accessToken: string,
  days = 90,
  keep = 30,
): Promise<CalendarSeries[]> {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date().toISOString();

  // calendarView returns expanded instances; seriesMasterId points at the master.
  // The Graph endpoint requires $-prefixed query params to be passed literally;
  // URLSearchParams strips the leading $ on encoding, so we build the string by hand.
  const url = `${BASE}/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=500&$select=id,subject,seriesMasterId,attendees,bodyPreview,responseStatus&$orderby=start/dateTime asc`;
  const res = await fetchWithRetry(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`graph calendarView ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    value?: Array<{
      id: string;
      subject?: string;
      seriesMasterId?: string;
      attendees?: Array<{ emailAddress?: { address?: string; name?: string }; status?: { response?: string } }>;
      bodyPreview?: string;
      responseStatus?: { response?: string };
    }>;
  };

  const seriesMap = new Map<string, {
    seriesId: string;
    title: string;
    attendeeEmails: Set<string>;
    occurrenceCount: number;
    description?: string;
    declined: boolean;
  }>();

  for (const ev of json.value ?? []) {
    if (!ev.seriesMasterId) continue;
    const declined = ev.responseStatus?.response === 'declined';
    const others = (ev.attendees ?? [])
      .map((a) => (a.emailAddress?.address ?? '').toLowerCase().trim())
      .filter(Boolean);
    if (others.length === 0) continue;

    const existing = seriesMap.get(ev.seriesMasterId);
    if (existing) {
      existing.occurrenceCount += 1;
      others.forEach((e) => existing.attendeeEmails.add(e));
      if (!declined) existing.declined = false;
    } else {
      const title = ev.subject ?? '(uden titel)';
      if (SKIP_TITLE_PATTERNS.some((re) => re.test(title.trim()))) continue;
      seriesMap.set(ev.seriesMasterId, {
        seriesId: ev.seriesMasterId,
        title,
        attendeeEmails: new Set(others),
        occurrenceCount: 1,
        description: ev.bodyPreview,
        declined,
      });
    }
  }

  return Array.from(seriesMap.values())
    .filter((s) => !s.declined)
    .map((s) => ({
      seriesId: s.seriesId,
      title: s.title,
      attendeeEmails: Array.from(s.attendeeEmails),
      recurrencePattern: `tilbagevendende (${s.occurrenceCount}× på ${days} dage)`,
      occurrenceCount: s.occurrenceCount,
      description: s.description,
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, keep);
}
