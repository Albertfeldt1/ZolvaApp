// supabase/functions/agent-reflect/index.ts
//
// Reflect sweep (~every 30 min). Per eligible user: read calendars, pick events
// starting within the lead window, emit deduped calendar.upcoming rows, and run
// the reflect strategy on the freshly-inserted rows. No qualifying event → no run.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runReflect } from '../_shared/agent/runner.ts';
import type { ClaimedEvent } from '../_shared/agent/runner.ts';
import {
  buildDeps,
  selectEligibleUserIds,
  loadGmailAccessToken,
  loadOutlookAccessToken,
} from '../agent-tick/index.ts';
import { googleListEvents, outlookListEvents } from '../_shared/agent/tools/calendar.ts';
import type { CalEvent } from '../_shared/agent/tools/calendar.ts';
import {
  filterUpcomingEvents,
  toUpcomingPayload,
  type RawCalEvent,
} from '../_shared/agent/reflect-events.ts';

const LEAD_MINUTES = 120;
const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function copenhagenDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// CalEvent -> RawCalEvent. The reader does not expose all-day or the self
// attendee's response status (see Reader gap below).
function mapCalEvent(e: CalEvent, provider: 'google' | 'microsoft'): RawCalEvent {
  return {
    event_id: e.id,
    provider,
    title: e.title,
    start: e.start,
    end: e.end,
    // all-day events carry a date-only start (no time component).
    all_day: !e.start.includes('T'),
    attendee_count: e.attendees.length,
    // TODO: reader does not yet surface the self-attendee response status; declined-event filtering is therefore inert until googleListEvents/outlookListEvents expose it. Fast follow.
    response_status: 'none',
    location: e.location ?? undefined,
    attendees: e.attendees,
  };
}

async function readUpcoming(
  client: SupabaseClient,
  userId: string,
  now: Date,
): Promise<RawCalEvent[]> {
  const startIso = now.toISOString();
  const endIso = new Date(now.getTime() + LEAD_MINUTES * 60_000).toISOString();
  const out: RawCalEvent[] = [];

  // Google — swallow per-provider errors so one bad provider doesn't blank the sweep.
  try {
    const gmailToken = await loadGmailAccessToken(client, userId);
    const events = await googleListEvents({
      fetch: fetch as never,
      accessToken: gmailToken,
      startIso,
      endIso,
    });
    for (const e of events) out.push(mapCalEvent(e, 'google'));
  } catch (err) {
    console.warn('[agent-reflect] google calendar read failed for', userId, err);
  }

  // Outlook — only if the user has a Microsoft refresh token.
  try {
    const outlookToken = await loadOutlookAccessToken(client, userId);
    if (outlookToken) {
      const events = await outlookListEvents({
        fetch: fetch as never,
        accessToken: outlookToken,
        startIso,
        endIso,
      });
      for (const e of events) out.push(mapCalEvent(e, 'microsoft'));
    }
  } catch (err) {
    console.warn('[agent-reflect] outlook calendar read failed for', userId, err);
  }

  return out;
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = new Date();
  const day = copenhagenDay(now);

  const userIds = await selectEligibleUserIds(client);

  const results: Array<{ userId: string; ran: boolean; error?: string }> = [];
  for (const uid of userIds) {
    try {
      const raw = await readUpcoming(client, uid, now);
      const picked = filterUpcomingEvents(raw, now, LEAD_MINUTES);
      if (picked.length === 0) {
        results.push({ userId: uid, ran: false });
        continue;
      }

      // Per-row dedup insert: the agent_events_calendar_upcoming_dedup unique
      // index raises 23505 when this event was already emitted today — skip it.
      const fresh: ClaimedEvent[] = [];
      for (const e of picked) {
        const payload = toUpcomingPayload(e, day, now);
        const { data, error } = await client
          .from('agent_events')
          .insert({ user_id: uid, kind: 'calendar.upcoming', payload })
          .select('id, kind, payload')
          .single();
        if (error) {
          if ((error as { code?: string }).code === '23505') continue; // already emitted today
          throw error;
        }
        fresh.push(data as ClaimedEvent);
      }

      if (fresh.length === 0) {
        results.push({ userId: uid, ran: false });
        continue;
      }

      const deps = buildDeps(client, uid);
      await runReflect({ userId: uid, events: fresh, deps });
      await client
        .from('agent_events')
        .update({ processed_at: new Date().toISOString() })
        .in('id', fresh.map((e) => e.id));
      results.push({ userId: uid, ran: true });
    } catch (err) {
      const msg = err instanceof Error
        ? `${err.name}: ${err.message}`
        : (() => {
            try { return JSON.stringify(err); } catch { return String(err); }
          })();
      console.error('[agent-reflect] error for', uid, msg, err);
      results.push({ userId: uid, ran: false, error: msg });
    }
  }

  return new Response(JSON.stringify({ results }), {
    headers: { 'content-type': 'application/json' },
  });
});
