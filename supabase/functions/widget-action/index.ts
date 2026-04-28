import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyJwt } from './jwt.ts';
import {
  emptyPrompt,
  loggedOut,
  noCalendarLabels,
  type WidgetActionResponse,
} from './responses.ts';

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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
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
  try {
    userId = (await verifyJwt(token)).userId;
  } catch {
    return json(401, loggedOut());
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

  // Subsequent tasks plug Claude + selection + provider write here.
  return json(200, {
    dialog: `OK · prompt=${prompt} · tz=${timezone} · labels=${JSON.stringify(labels)}`,
    snippet: { mood: 'happy', summary: 'TODO pipeline', deepLink: 'zolva://chat' },
  });
}

serve(workerHandler);
