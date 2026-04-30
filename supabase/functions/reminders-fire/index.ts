// supabase/functions/reminders-fire/index.ts
//
// Cron-driven reminder firing. Replaces client-side expo-notifications
// scheduling, which proved unreliable (settings hydrate race, OS
// permission revoke, app deleted before due time, etc.).
//
// Idempotency: fired_at is stamped after the push attempt, gated by
// .is('fired_at', null) on the UPDATE — so two ticks hitting the same
// row both attempt to update, but the second matches zero rows.
// Stamping after means a crash between push and UPDATE could double-fire
// on the next tick; we accept that over the alternative (stamp first +
// crash leaves the user with no notification).
//
// Deploy with --no-verify-jwt: ES256 keys, manual cron-secret check.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 50;

serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  if (!supabaseUrl || !serviceKey || !cronSecret) {
    return json({ error: 'missing env' }, 500);
  }
  const presented = req.headers.get('x-cron-secret');
  if (presented !== cronSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: due, error } = await client
    .from('reminders')
    .select('id, user_id, title, due_at')
    .lte('due_at', new Date().toISOString())
    .eq('completed', false)
    .is('fired_at', null)
    .order('due_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    console.error('[reminders-fire] select failed:', error.message);
    return json({ error: 'db error' }, 500);
  }

  const rows = (due ?? []) as Array<{
    id: string; user_id: string; title: string; due_at: string;
  }>;
  if (rows.length === 0) return json({ processed: 0 });

  // Group reminders by user so we send one push per user even if they
  // have multiple due at the same minute. First title becomes the
  // headline, count goes in the body.
  const byUser = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byUser.get(r.user_id) ?? [];
    arr.push(r);
    byUser.set(r.user_id, arr);
  }

  let pushed = 0;
  for (const [userId, userRows] of byUser) {
    const tokens = await loadTokens(client, userId);
    if (tokens.length > 0) {
      const ok = await sendPush(tokens, userRows);
      if (ok) pushed += userRows.length;
    }
    // Stamp fired_at regardless of push success — failed pushes don't
    // get retried. Cost of double-pushing is worse than missing one.
    await client
      .from('reminders')
      .update({ fired_at: new Date().toISOString() })
      .in('id', userRows.map((r) => r.id))
      .is('fired_at', null);
  }

  console.log(JSON.stringify({ kind: 'reminders-fire', processed: rows.length, pushed }));
  return json({ processed: rows.length, pushed });
});

async function loadTokens(client: SupabaseClient, userId: string): Promise<string[]> {
  const { data } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  return (data ?? []).map((r) => (r as { token: string }).token);
}

async function sendPush(
  tokens: string[],
  reminders: Array<{ id: string; title: string }>,
): Promise<boolean> {
  const headline = reminders[0].title;
  const body = reminders.length === 1
    ? headline
    : `${headline}\n+ ${reminders.length - 1} flere påmindelser`;
  const messages = tokens.map((token) => ({
    to: token,
    title: 'Påmindelse fra Zolva',
    body,
    sound: 'default',
    data: {
      type: 'reminder',
      reminderId: reminders[0].id,
    },
  }));
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages),
    });
    return res.ok;
  } catch (err) {
    console.warn('[reminders-fire] push send failed:', err);
    return false;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
