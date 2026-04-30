// supabase/functions/_shared/backfill-providers/google-calendar.ts

import type { CalendarSeries } from '../onboarding-backfill.ts';
import { fetchWithRetry } from '../onboarding-backfill.ts';

const BASE = 'https://www.googleapis.com/calendar/v3';

const SKIP_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^lunch$/i,
  /^frokost$/i,
  /^coffee$/i,
  /^kaffe$/i,
  /^1:1$/i,
  /^one[- ]on[- ]one$/i,
  /^pause$/i,
  /^standup$/i,
];

export async function fetchGoogleRecurring(
  accessToken: string,
  days = 90,
  keep = 30,
): Promise<CalendarSeries[]> {
  const timeMin = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date().toISOString();

  // Get all instances in window with singleEvents=true so we receive expanded
  // occurrences; each carries recurringEventId pointing at the master.
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    maxResults: '500',
    fields: 'items(id,summary,recurringEventId,attendees(email,self,responseStatus),description,start)',
  });
  const url = `${BASE}/calendars/primary/events?${params.toString()}`;
  const res = await fetchWithRetry(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`google calendar list ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      recurringEventId?: string;
      attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
      description?: string;
      start?: { dateTime?: string; date?: string };
    }>;
  };

  // Group by recurringEventId; only keep events that ARE recurring.
  const seriesMap = new Map<string, {
    seriesId: string;
    title: string;
    attendeeEmails: Set<string>;
    occurrenceCount: number;
    description?: string;
    declined: boolean;
  }>();

  for (const ev of json.items ?? []) {
    if (!ev.recurringEventId) continue;
    const userResponse = ev.attendees?.find((a) => a.self === true)?.responseStatus;
    const declined = userResponse === 'declined';
    const otherAttendees = (ev.attendees ?? [])
      .filter((a) => a.self !== true)
      .map((a) => (a.email ?? '').toLowerCase().trim())
      .filter(Boolean);
    if (otherAttendees.length === 0) continue;  // solo blocks

    const existing = seriesMap.get(ev.recurringEventId);
    if (existing) {
      existing.occurrenceCount += 1;
      otherAttendees.forEach((e) => existing.attendeeEmails.add(e));
      if (!declined) existing.declined = false;
    } else {
      const title = ev.summary ?? '(uden titel)';
      if (SKIP_TITLE_PATTERNS.some((re) => re.test(title.trim()))) continue;
      seriesMap.set(ev.recurringEventId, {
        seriesId: ev.recurringEventId,
        title,
        attendeeEmails: new Set(otherAttendees),
        occurrenceCount: 1,
        description: ev.description,
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
