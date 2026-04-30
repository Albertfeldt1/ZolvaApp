// Logging: ephemeral only (privacy policy specifies "Error logs without content: up to 30 days").
// No widget_action_calls table. Supabase platform log retention applies (~7 days).
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractAction } from './claude.ts';
import type { ClaudeExtractionEvent } from './claude.ts';
import { verifyJwt } from './jwt.ts';
import {
  emptyPrompt,
  loggedOut,
  noCalendarLabels,
  oauthInvalid,
  permissionDenied,
  provider5xx,
  reminderCreated,
  unparseable,
  type WidgetActionResponse,
} from './responses.ts';
import { selectCalendar } from './select-calendar.ts';
import { writeEvent } from './provider-write.ts';
import { naturalTime, truncate } from './format.ts';

type WidgetActionRequest = {
  prompt?: string;
  timezone?: string;
  locale?: string;
};

type CalendarProvider = 'google' | 'microsoft' | 'icloud';
type CalendarLabelTarget = { provider: CalendarProvider; id: string };
type LabelMap = { work?: CalendarLabelTarget; personal?: CalendarLabelTarget };

const json = (status: number, body: WidgetActionResponse): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function admin(): SupabaseClient {
  // Read env lazily so tests can set Deno.env after import.
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function readLabels(
  client: SupabaseClient,
  userId: string,
): Promise<LabelMap> {
  const { data } = await client
    .from('user_profiles')
    .select(
      'work_calendar_provider, work_calendar_id, personal_calendar_provider, personal_calendar_id',
    )
    .eq('user_id', userId)
    .maybeSingle();
  const row = (data ?? null) as null | {
    work_calendar_provider: CalendarProvider | null;
    work_calendar_id: string | null;
    personal_calendar_provider: CalendarProvider | null;
    personal_calendar_id: string | null;
  };
  const out: LabelMap = {};
  // Defensive null-check: even though the DB constraints guarantee both
  // null or both set, treat as unconfigured if either is missing — defends
  // against constraint drift or partial reads.
  if (row?.work_calendar_provider && row.work_calendar_id) {
    out.work = { provider: row.work_calendar_provider, id: row.work_calendar_id };
  }
  if (row?.personal_calendar_provider && row.personal_calendar_id) {
    out.personal = {
      provider: row.personal_calendar_provider,
      id: row.personal_calendar_id,
    };
  }
  return out;
}

export async function workerHandler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;

  let userId: string;
  const testUserId = Deno.env.get('WIDGET_ACTION_TEST_USER_ID');
  if (testUserId) {
    userId = testUserId;
  } else {
    try {
      userId = (await verifyJwt(token)).userId;
    } catch {
      return json(401, loggedOut());
    }
  }

  const body = (await req.json().catch(() => ({}))) as WidgetActionRequest;
  const prompt = (body.prompt ?? '').trim();
  const timezone = body.timezone ?? 'UTC';

  if (prompt === '') {
    // empty_prompt — log + return.
    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: 'empty_prompt',
      calendar_resolution: 'no_calendar',
    }));
    return json(200, emptyPrompt());
  }

  let extraction;
  try {
    const claude = await extractAction(prompt, timezone);
    extraction = claude.extraction;
    // usage + model captured for logging in Task 18.
  } catch (err) {
    console.warn('[widget-action] claude error:', err instanceof Error ? err.message : err);
    return json(200, unparseable());
  }

  // Reminder branch — split before the calendar-event flow.
  if (extraction.kind === 'reminder') {
    const text = (extraction.text ?? '').trim();
    if (!text) {
      console.log(JSON.stringify({
        action: 'create_reminder', user_id: userId, success: false,
        error_class: 'unparseable', prompt_language: extraction.prompt_language,
      }));
      return json(200, unparseable());
    }
    const dueAt = extraction.due_at ? new Date(extraction.due_at) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      return json(200, unparseable());
    }
    const supabaseClient = admin();
    const { data: inserted, error } = await supabaseClient
      .from('reminders')
      .insert({
        user_id: userId,
        title: text,
        due_at: (dueAt ?? new Date('2099-12-31T00:00:00Z')).toISOString(),
        scheduled_for_tz: timezone,
      })
      .select('id, due_at')
      .single();
    if (error || !inserted) {
      console.error('[widget-action] reminder insert failed:', error?.message);
      console.log(JSON.stringify({
        action: 'create_reminder', user_id: userId, success: false,
        error_class: 'db_error', prompt_language: extraction.prompt_language,
      }));
      return json(200, unparseable());
    }
    console.log(JSON.stringify({
      action: 'create_reminder', user_id: userId, success: true,
      reminder_id: inserted.id, due_iso: inserted.due_at,
      prompt_language: extraction.prompt_language,
    }));
    return json(200, reminderCreated(extraction, timezone));
  }

  // extraction.kind === 'event' from here on.
  const eventExtraction = extraction as ClaudeExtractionEvent;

  if (eventExtraction.title === 'UNPARSEABLE') {
    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: 'unparseable',
      calendar_resolution: 'no_calendar',
      prompt_language: eventExtraction.prompt_language,
    }));
    return json(200, unparseable());
  }

  const labels = await readLabels(admin(), userId);
  if (!labels.work && !labels.personal) {
    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: 'no_calendar_labels',
      calendar_resolution: 'no_calendar',
    }));
    return json(200, noCalendarLabels());
  }

  const selection = selectCalendar({
    hint: eventExtraction.calendar_label,
    labels,
  });
  if (!selection.target) {
    // Defensive: labels were checked above. Treat like no_calendar_labels.
    return json(200, noCalendarLabels());
  }

  const startIso = eventExtraction.start;
  const endIso = eventExtraction.end ?? new Date(new Date(eventExtraction.start).getTime() + 60 * 60 * 1000).toISOString();

  const supabaseClient = admin();
  const write = await writeEvent({
    client: supabaseClient,
    userId,
    provider: selection.target.provider,
    calendarId: selection.target.id,
    title: eventExtraction.title,
    startIso,
    endIso,
    timezone,
  });

  if (!write.ok) {
    let resp;
    if (write.errorClass === 'oauth_invalid') resp = oauthInvalid(selection.target.provider);
    else if (write.errorClass === 'permission_denied') resp = permissionDenied(write.calendarName);
    else resp = provider5xx(selection.target.provider);

    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: write.errorClass,
      calendar_resolution: selection.resolution,
      calendar_provider: selection.target.provider,
      prompt_language: eventExtraction.prompt_language,
    }));
    return json(200, resp);
  }

  const locale: 'da' | 'en' = eventExtraction.prompt_language === 'en' ? 'en' : 'da';
  const time = naturalTime({
    eventIso: startIso,
    nowIso: new Date().toISOString(),
    locale,
    timezone,
  });

  const labelWord = locale === 'da'
    ? selection.usedLabel === 'work' ? 'arbejds' : 'privat'
    : selection.usedLabel === 'work' ? 'work' : 'personal';

  let dialog: string;
  if (locale === 'da') {
    dialog = `Tilføjet: '${eventExtraction.title}', ${time} i din ${labelWord}kalender.`;
    if (selection.fallbackFromLabel) {
      const missing = selection.fallbackFromLabel === 'work' ? 'arbejds' : 'privat';
      dialog = `Tilføjet i din ${labelWord}kalender — du har ikke valgt en ${missing}-kalender endnu. ${dialog}`;
    }
  } else {
    dialog = `Added: '${eventExtraction.title}', ${time} in your ${labelWord} calendar.`;
    if (selection.fallbackFromLabel) {
      dialog = `Added to your ${labelWord} calendar — you haven't picked a ${selection.fallbackFromLabel} calendar yet. ${dialog}`;
    }
  }

  const summary = `${eventExtraction.title} · ${time}`;

  const truncated = {
    dialog: truncate(dialog, 120),
    snippet: {
      mood: 'happy' as const,
      summary: truncate(summary, 80),
      deepLink: write.eventUrl ?? `zolva://calendar/event/${encodeURIComponent(write.eventId)}`,
    },
  };

  console.log(JSON.stringify({
    action: 'create_event',
    user_id: userId,
    success: true,
    calendar_resolution: selection.resolution,
    calendar_provider: selection.target.provider,
    prompt_language: eventExtraction.prompt_language,
  }));

  return json(200, truncated);
}

serve(workerHandler);
