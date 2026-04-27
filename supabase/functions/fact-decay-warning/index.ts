// supabase/functions/fact-decay-warning/index.ts
//
// Daily cron worker for action-y facts (commitments).
//
//   1. Heads-up notification: every confirmed fact whose expires_at falls in
//      the next 24h and hasn't already been warned about gets one push
//      notification. decay_warning_sent_at is stamped so the next run skips
//      it. Tap routes the user to the Memory tab.
//
//   2. Hard purge: facts that decayed more than 30 days ago are deleted so
//      the table doesn't bloat with rows nobody will ever read again.
//
// Auth: pg_cron sends a service-role bearer + x-cron-secret. We don't accept
// user-JWT calls — there's nothing for an end user to invoke here.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const WARN_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
const PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const PUSH_TITLE = 'Faktum udløber snart';

type FactRow = {
  id: string;
  user_id: string;
  text: string;
  expires_at: string;
};

serve(async (req) => {
  // Cron-only entrypoint. No user JWT support. Uses the same shared secret
  // env var name as poll-mail / daily-brief so a single secret can rotate.
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return new Response('unauthorized', { status: 401 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response('misconfigured', { status: 500 });
  }

  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const now = new Date();
  const horizon = new Date(now.getTime() + WARN_LOOKAHEAD_MS);

  // 1) Fetch facts about to decay that haven't been warned yet.
  const { data: dueRaw, error: dueErr } = await svc
    .from('facts')
    .select('id, user_id, text, expires_at')
    .eq('status', 'confirmed')
    .gt('expires_at', now.toISOString())
    .lte('expires_at', horizon.toISOString())
    .is('decay_warning_sent_at', null);
  if (dueErr) {
    console.warn('[fact-decay-warning] select failed:', dueErr.message);
    return json({ ok: false, error: dueErr.message }, 500);
  }
  const due = (dueRaw ?? []) as FactRow[];

  let warned = 0;
  for (const fact of due) {
    const ok = await pushDecayWarning(svc, fact);
    if (ok) warned += 1;
    // Stamp regardless of push success: a failed Expo deliver shouldn't
    // cause a duplicate push tomorrow. The notification can be retried
    // server-side if/when we add delivery receipts.
    await svc
      .from('facts')
      .update({ decay_warning_sent_at: new Date().toISOString() })
      .eq('id', fact.id);
  }

  // 2) Hard-purge stale rows so the table doesn't grow unbounded.
  const purgeCutoff = new Date(now.getTime() - PURGE_GRACE_MS).toISOString();
  const { error: purgeErr, count: purged } = await svc
    .from('facts')
    .delete({ count: 'exact' })
    .lt('expires_at', purgeCutoff);
  if (purgeErr) {
    console.warn('[fact-decay-warning] purge failed:', purgeErr.message);
  }

  return json({ ok: true, candidates: due.length, warned, purged: purged ?? 0 });
});

async function pushDecayWarning(svc: SupabaseClient, fact: FactRow): Promise<boolean> {
  const { data: tokens, error } = await svc
    .from('push_tokens')
    .select('token')
    .eq('user_id', fact.user_id);
  if (error || !tokens || tokens.length === 0) return false;

  // Truncate the fact text so the notification body fits comfortably on the
  // lock screen. Mid-sentence cut is fine — the full text lives in the app.
  const preview = fact.text.length > 120 ? `${fact.text.slice(0, 117)}…` : fact.text;
  const body = `Husk eller lad det glide: ${preview}`;
  const messages = tokens.map((t) => ({
    to: (t as Record<string, string>).token,
    title: PUSH_TITLE,
    body,
    sound: 'default',
    data: { type: 'factDecay', factId: fact.id },
  }));

  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok && Deno.env.get('DEBUG')) {
      console.warn('[fact-decay-warning] expo push non-200:', res.status);
    }
    return res.ok;
  } catch (err) {
    console.warn('[fact-decay-warning] push send failed', err);
    return false;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
