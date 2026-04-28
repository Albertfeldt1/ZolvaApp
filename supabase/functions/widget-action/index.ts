import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractEvent } from './claude.ts';
import { verifyJwt } from './jwt.ts';
import {
  emptyPrompt,
  loggedOut,
  noCalendarLabels,
  oauthInvalid,
  permissionDenied,
  provider5xx,
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

type CalendarLabelTarget = { provider: 'google' | 'microsoft'; id: string };
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
    work_calendar_provider: 'google' | 'microsoft' | null;
    work_calendar_id: string | null;
    personal_calendar_provider: 'google' | 'microsoft' | null;
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

  let extraction;
  try {
    const claude = await extractEvent(prompt, timezone);
    extraction = claude.extraction;
    // usage + model captured for logging in Task 18.
  } catch (err) {
    console.warn('[widget-action] claude error:', err instanceof Error ? err.message : err);
    return json(200, unparseable());
  }

  if (extraction.title === 'UNPARSEABLE') {
    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: 'unparseable',
      calendar_resolution: 'no_calendar',
      prompt_language: extraction.prompt_language,
    }));
    return json(200, unparseable());
  }

  const selection = selectCalendar({
    hint: extraction.calendar_label,
    labels,
  });
  if (!selection.target) {
    // Defensive: caller exited on empty labels above. Treat like no_calendar_labels.
    return json(200, noCalendarLabels());
  }

  const startIso = extraction.start;
  const endIso = extraction.end ?? new Date(new Date(extraction.start).getTime() + 60 * 60 * 1000).toISOString();

  const supabaseClient = admin();
  const write = await writeEvent({
    client: supabaseClient,
    userId,
    provider: selection.target.provider,
    calendarId: selection.target.id,
    title: extraction.title,
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
      prompt_language: extraction.prompt_language,
    }));
    return json(200, resp);
  }

  const locale: 'da' | 'en' = extraction.prompt_language === 'en' ? 'en' : 'da';
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
    dialog = `Tilføjet: '${extraction.title}', ${time} i din ${labelWord}kalender.`;
    if (selection.fallbackFromLabel) {
      const missing = selection.fallbackFromLabel === 'work' ? 'arbejds' : 'privat';
      dialog = `Tilføjet i din ${labelWord}kalender — du har ikke valgt en ${missing}-kalender endnu. ${dialog}`;
    }
  } else {
    dialog = `Added: '${extraction.title}', ${time} in your ${labelWord} calendar.`;
    if (selection.fallbackFromLabel) {
      dialog = `Added to your ${labelWord} calendar — you haven't picked a ${selection.fallbackFromLabel} calendar yet. ${dialog}`;
    }
  }

  const summary = `${extraction.title} · ${time}`;

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
    prompt_language: extraction.prompt_language,
  }));

  return json(200, truncated);
}

serve(workerHandler);
