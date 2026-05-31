// supabase/functions/_shared/agent/reflect-events.ts
//
// Pure selection of which upcoming calendar events warrant a reflect run.
// Provider readers normalise into RawCalEvent; this module decides what stays.
export interface RawCalEvent {
  event_id: string;
  provider: 'google' | 'microsoft';
  title: string;
  start: string; // ISO-8601
  end: string;   // ISO-8601
  all_day: boolean;
  attendee_count: number;
  response_status: 'accepted' | 'tentative' | 'declined' | 'needsAction' | 'none';
  location?: string;
  description?: string;
  attendees?: string[];
}

export function filterUpcomingEvents(events: RawCalEvent[], now: Date, leadMinutes: number): RawCalEvent[] {
  const horizon = now.getTime() + leadMinutes * 60_000;
  return events.filter((e) => {
    if (e.all_day) return false;
    if (e.attendee_count < 2) return false;            // solo / focus block
    if (e.response_status === 'declined') return false;
    const start = new Date(e.start).getTime();
    if (Number.isNaN(start)) return false;
    return start > now.getTime() && start <= horizon;  // strictly upcoming, within window
  });
}

export function toUpcomingPayload(e: RawCalEvent, day: string, now: Date): Record<string, unknown> {
  return {
    event_id: e.event_id, provider: e.provider, title: e.title, start: e.start,
    location: e.location, attendees: e.attendees, description: e.description,
    minutes_until: Math.round((new Date(e.start).getTime() - now.getTime()) / 60_000),
    day,
  };
}
