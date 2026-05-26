// Logging: ephemeral only (privacy policy specifies "Error logs without content: up to 30 days").
// No widget_action_calls table. Supabase platform log retention applies (~7 days).
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractAction } from './claude.ts';
import { recordAiUsage } from '../_shared/usage.ts';
import type { ClaudeExtraction } from './claude.ts';
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
  idempotency_key?: string;
};

// Read window for the idempotency table. Siri retries don't span hours;
// 15 min covers any plausible network-layer or iOS-client retry inside a
// single user invocation while keeping stale rows from masking a genuine
// re-attempt. See supabase/migrations/20260510130000_widget_action_idempotency.sql.
const IDEMPOTENCY_READ_WINDOW_MS = 15 * 60 * 1000;
const IDEMPOTENCY_KEY_MAX_LEN = 64;

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
  // null or both set, treat as unconfigured if either is missing - defends
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
  try {
    userId = (await verifyJwt(token)).userId;
  } catch {
    return json(401, loggedOut());
  }

  const body = (await req.json().catch(() => ({}))) as WidgetActionRequest;
  const prompt = (body.prompt ?? '').trim();
  const timezone = body.timezone ?? 'UTC';
  const idempotencyKey =
    typeof body.idempotency_key === 'string' &&
    body.idempotency_key.length > 0 &&
    body.idempotency_key.length <= IDEMPOTENCY_KEY_MAX_LEN
      ? body.idempotency_key
      : null;

  // Idempotency short-circuit. The iOS client generates a UUID per Siri
  // invocation; if the same (user, key) appears within the read window,
  // return the recorded response instead of re-running the side-effecting
  // calendar/reminder write. See migration 20260510130000.
  if (idempotencyKey) {
    const cutoffIso = new Date(Date.now() - IDEMPOTENCY_READ_WINDOW_MS).toISOString();
    const cached = await admin()
      .from('widget_action_idempotency')
      .select('response_json')
      .eq('user_id', userId)
      .eq('idempotency_key', idempotencyKey)
      .gt('created_at', cutoffIso)
      .maybeSingle();
    if (cached.data) {
      return json(200, (cached.data as { response_json: WidgetActionResponse }).response_json);
    }
  }

  // Wrap every successful (200) response so the recorded body matches what
  // the client received byte-for-byte. 401 / 405 paths above don't go
  // through this — they're pre-idempotency-check by design (no userId yet
  // for 401, no body for 405).
  const respond = async (resp: WidgetActionResponse): Promise<Response> => {
    if (idempotencyKey) {
      const { error } = await admin()
        .from('widget_action_idempotency')
        .upsert(
          {
            user_id: userId,
            idempotency_key: idempotencyKey,
            response_json: resp,
          },
          { onConflict: 'user_id,idempotency_key' },
        );
      if (error) {
        // Don't fail the request - we already produced a real response.
        // Log so we notice if persist failures spike (would indicate the
        // dedupe story is silently broken).
        console.warn('[widget-action] idempotency persist failed:', error.message);
      }
    }
    return json(200, resp);
  };

  if (prompt === '') {
    // empty_prompt - log + return.
    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: 'empty_prompt',
      calendar_resolution: 'no_calendar',
    }));
    return await respond(emptyPrompt());
  }

  let extraction: ClaudeExtraction;
  try {
    const claude = await extractAction(prompt, timezone);
    extraction = claude.extraction;
    void recordAiUsage(admin(), userId, 'widget-action', claude.model, {
      input_tokens: claude.usage.input,
      output_tokens: claude.usage.output,
    });
  } catch (err) {
    console.warn('[widget-action] claude error:', err instanceof Error ? err.message : err);
    return await respond(unparseable());
  }

  // Reminder branch - split before the calendar-event flow.
  if (extraction.kind === 'reminder') {
    const text = (extraction.text ?? '').trim();
    if (!text) {
      console.log(JSON.stringify({
        action: 'create_reminder', user_id: userId, success: false,
        error_class: 'unparseable', prompt_language: extraction.prompt_language,
      }));
      return await respond(unparseable());
    }
    const dueAt = extraction.due_at ? new Date(extraction.due_at) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      return await respond(unparseable());
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
      return await respond(unparseable());
    }
    console.log(JSON.stringify({
      action: 'create_reminder', user_id: userId, success: true,
      reminder_id: inserted.id, due_iso: inserted.due_at,
      prompt_language: extraction.prompt_language,
    }));
    return await respond(reminderCreated(extraction, timezone));
  }

  // extraction.kind narrows to 'event' here via the discriminated union.
  const eventExtraction = extraction;

  const labels = await readLabels(admin(), userId);
  if (!labels.work && !labels.personal) {
    console.log(JSON.stringify({
      action: 'create_event',
      user_id: userId,
      success: false,
      error_class: 'no_calendar_labels',
      calendar_resolution: 'no_calendar',
    }));
    return await respond(noCalendarLabels());
  }

  const selection = selectCalendar({
    hint: eventExtraction.calendar_label,
    labels,
  });
  if (!selection.target) {
    // Defensive: labels were checked above. Treat like no_calendar_labels.
    return await respond(noCalendarLabels());
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
    return await respond(resp);
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
      dialog = `Tilføjet i din ${labelWord}kalender - du har ikke valgt en ${missing}-kalender endnu. ${dialog}`;
    }
  } else {
    dialog = `Added: '${eventExtraction.title}', ${time} in your ${labelWord} calendar.`;
    if (selection.fallbackFromLabel) {
      dialog = `Added to your ${labelWord} calendar - you haven't picked a ${selection.fallbackFromLabel} calendar yet. ${dialog}`;
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

  return await respond(truncated);
}

serve(workerHandler);
