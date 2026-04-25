// poll-mail — Supabase Edge Function scaffold.
//
// Invoked on a cron schedule (see supabase/schedule-poll-mail.sql.template).
// For every user with an `enabled` mail_watchers row, fetch new mail from
// the provider since the last watermark and dispatch an Expo push for each
// new message.
//
// CALLER GATING. Because this function runs with the service role internally,
// we must not let any authenticated user trigger the full batch (cost
// amplification). The function accepts two caller identities:
//
//   1. Cron — must present header `x-cron-secret: <CRON_SHARED_SECRET>`.
//      Processes every enabled watcher.
//   2. Authenticated user — must present a valid user JWT in `Authorization`.
//      Processes only the caller's own mail_watchers rows.
//
// Any other caller (no/invalid JWT, no cron secret) is rejected with 401.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';

type Watcher = {
  user_id: string;
  provider: 'google' | 'microsoft';
  enabled: boolean;
  last_history_id: string | null;
  last_delta_link: string | null;
};

type PushToken = { token: string };

type NewMessage = {
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ error: 'missing env' }, 500);
  }

  // Identity gate. Either the cron shared secret matches (full batch), or
  // we require a valid user JWT and scope the batch to that user only.
  const presentedSecret = req.headers.get('x-cron-secret');
  const isCron = !!cronSecret && presentedSecret === cronSecret;

  let scopedUserId: string | null = null;
  if (!isCron) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return json({ error: 'unauthorized' }, 401);
    }
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData.user) {
      return json({ error: 'unauthorized' }, 401);
    }
    scopedUserId = userData.user.id;
  }

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  let query = client.from('mail_watchers').select('*').eq('enabled', true);
  if (scopedUserId) {
    query = query.eq('user_id', scopedUserId);
  }
  const { data: watchers, error } = await query;
  if (error) return json({ error: error.message }, 500);

  const summary: Record<string, string> = {};
  for (const watcher of (watchers ?? []) as Watcher[]) {
    const key = `${watcher.user_id}:${watcher.provider}`;
    const { data: locked, error: lockErr } = await client.rpc('try_mail_watcher_lock', {
      p_user_id: watcher.user_id,
    });
    if (lockErr) {
      summary[key] = `error: lock ${lockErr.message}`;
      continue;
    }
    if (!locked) {
      summary[key] = 'skipped: locked';
      continue;
    }
    try {
      await processWatcher(client, watcher);
      summary[key] = 'ok';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary[key] = `error: ${msg}`;
    } finally {
      await client.rpc('release_mail_watcher_lock', { p_user_id: watcher.user_id });
    }
  }
  return json({ caller: isCron ? 'cron' : `user:${scopedUserId}`, summary });
});

const BATCH_PUSH_THRESHOLD = 10;

async function processWatcher(client: SupabaseClient, watcher: Watcher): Promise<void> {
  const refreshToken = await loadRefreshToken(client, watcher.user_id, watcher.provider);
  if (!refreshToken) {
    throw new Error('no refresh token — complete auth.ts capture first');
  }

  const { accessToken } = await refreshAccessToken(
    client,
    watcher.user_id,
    watcher.provider,
    refreshToken,
  );
  const { messages, nextHistoryId, nextDeltaLink } =
    watcher.provider === 'google'
      ? await fetchGmailSince(accessToken, watcher.last_history_id)
      : await fetchGraphSince(accessToken, watcher.last_delta_link);

  // Advance the watermark before dispatching pushes so a failed/retried
  // run can't re-notify the same messages.
  await client
    .from('mail_watchers')
    .update({
      last_history_id: nextHistoryId ?? watcher.last_history_id,
      last_delta_link: nextDeltaLink ?? watcher.last_delta_link,
      last_polled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', watcher.user_id)
    .eq('provider', watcher.provider);

  if (messages.length === 0) return;
  const tokens = await loadPushTokens(client, watcher.user_id);
  if (tokens.length === 0) return;

  if (messages.length > BATCH_PUSH_THRESHOLD) {
    await dispatchBatchPush(tokens, watcher.provider, messages.length);
    return;
  }
  for (const msg of messages) {
    await dispatchExpoPush(tokens, watcher.provider, msg);
  }
}

async function fetchGmailSince(
  accessToken: string,
  lastHistoryId: string | null,
): Promise<{ messages: NewMessage[]; nextHistoryId: string | null; nextDeltaLink: null }> {
  if (!lastHistoryId) {
    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!profileRes.ok) throw new Error(`gmail profile ${profileRes.status}`);
    const profile = (await profileRes.json()) as { historyId?: string };
    return { messages: [], nextHistoryId: profile.historyId ?? null, nextDeltaLink: null };
  }
  const historyRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${lastHistoryId}&historyTypes=messageAdded`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!historyRes.ok) throw new Error(`gmail history ${historyRes.status}`);
  const history = (await historyRes.json()) as {
    history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId?: string } }> }>;
    historyId?: string;
  };

  const added = (history.history ?? [])
    .flatMap((h) => h.messagesAdded ?? [])
    .map((m) => ({ id: m.message.id, threadId: m.message.threadId }));

  const messages: NewMessage[] = [];
  for (const m of added) {
    const metaRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!metaRes.ok) continue;
    const meta = (await metaRes.json()) as {
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const headers = meta.payload?.headers ?? [];
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(uden emne)';
    const from = headers.find((h) => h.name === 'From')?.value ?? '';
    messages.push({ messageId: m.id, threadId: m.threadId, subject, from });
  }

  return { messages, nextHistoryId: history.historyId ?? lastHistoryId, nextDeltaLink: null };
}

async function fetchGraphSince(
  accessToken: string,
  lastDeltaLink: string | null,
): Promise<{ messages: NewMessage[]; nextHistoryId: null; nextDeltaLink: string | null }> {
  const url =
    lastDeltaLink ??
    'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject,from';
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`graph delta ${res.status}`);
  const j = (await res.json()) as {
    value?: Array<{
      id: string;
      subject?: string;
      from?: { emailAddress?: { address?: string; name?: string } };
    }>;
    '@odata.deltaLink'?: string;
  };

  const messages: NewMessage[] = lastDeltaLink
    ? (j.value ?? []).map((m) => ({
        messageId: m.id,
        subject: m.subject ?? '(uden emne)',
        from: m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? '',
      }))
    : [];

  return {
    messages,
    nextHistoryId: null,
    nextDeltaLink: j['@odata.deltaLink'] ?? lastDeltaLink,
  };
}

async function loadPushTokens(client: SupabaseClient, userId: string): Promise<PushToken[]> {
  const { data, error } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  if (error) throw new Error(`push_tokens select: ${error.message}`);
  return (data ?? []) as PushToken[];
}

async function dispatchExpoPush(
  tokens: PushToken[],
  provider: 'google' | 'microsoft',
  message: NewMessage,
): Promise<void> {
  if (tokens.length === 0) return;
  const body = tokens.map((t) => ({
    to: t.token,
    title: message.from || 'Ny mail',
    body: message.subject,
    data: {
      type: 'newMail',
      provider,
      messageId: message.messageId,
      threadId: message.threadId,
    },
    sound: 'default',
  }));
  await postExpoPush(body);
}

async function dispatchBatchPush(
  tokens: PushToken[],
  provider: 'google' | 'microsoft',
  count: number,
): Promise<void> {
  const body = tokens.map((t) => ({
    to: t.token,
    title: `${count} nye emails`,
    body: 'Åbn Zolva for at se dem.',
    data: { type: 'newMail', provider, batch: true, count },
    sound: 'default',
  }));
  await postExpoPush(body);
}

async function postExpoPush(body: unknown[]): Promise<void> {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn('[poll-mail] expo push non-ok:', res.status, await res.text());
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
