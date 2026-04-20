// delete-account — Supabase Edge Function.
//
// Wipes every piece of state tied to the calling user and then deletes the
// auth user itself. Only the authenticated user can invoke this — we
// derive the userId from their JWT, so there is no way to target someone
// else's account.
//
// Deletion order is important for idempotency. We delete application rows
// BEFORE calling admin.deleteUser. The foreign keys have `on delete
// cascade` on `auth.users`, so admin.deleteUser alone is sufficient in the
// happy path — but doing explicit deletes first means that if the admin
// call fails, the client can safely re-invoke with the still-valid JWT and
// the function will pick up where it left off.
//
// ROLLBACK NOTE: once admin.deleteUser succeeds, the user row is gone and
// their JWT is invalid. Application rows are already deleted by this point.
// There is no automatic rollback — deletion is intentionally one-way.
// If admin.deleteUser fails, the application rows deleted earlier cannot
// be restored; we surface the error so the user can retry (the
// idempotent re-run will succeed once the transient issue clears).

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

type Revocation = 'ok' | 'skipped' | 'failed';

serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    console.error('[delete-account] missing env');
    return json({ error: 'server misconfigured' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'missing bearer token' }, 401);
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) {
    return json({ error: 'unauthorized' }, 401);
  }
  const userId = userData.user.id;

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const revocations: Record<string, Revocation> = {};
  try {
    const tokens = await loadRefreshTokens(admin, userId);
    revocations.google = await revokeGoogle(tokens.google);
    // Microsoft has no per-token revocation endpoint (v2.0 token service
    // rejects revocation requests). We delete our copy below; the grant
    // remains until the user revokes it in their Microsoft account or it
    // naturally expires.
    revocations.microsoft = tokens.microsoft ? 'skipped' : 'skipped';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[delete-account] revoke phase failed user=${userId}: ${msg}`);
  }

  const tableDeletes = await deleteUserRows(admin, userId);

  const { error: adminErr } = await admin.auth.admin.deleteUser(userId);
  if (adminErr) {
    const msg = adminErr.message.toLowerCase();
    // Treat "not found" as success — the user is already gone, so a re-run
    // of a partial deletion is idempotent.
    if (!msg.includes('not found') && !msg.includes('no user')) {
      console.error(`[delete-account] admin deleteUser failed user=${userId} err=${adminErr.message}`);
      return json({
        error: 'account deletion failed at final step — data rows already removed, please retry',
        stage: 'admin_delete_user',
        detail: adminErr.message,
        rows_deleted: tableDeletes,
      }, 500);
    }
  }

  console.log(`[delete-account] ok user=${userId} revocations=${JSON.stringify(revocations)} rows=${JSON.stringify(tableDeletes)}`);
  return json({ ok: true, revocations, rows_deleted: tableDeletes });
});

async function loadRefreshTokens(
  client: SupabaseClient,
  userId: string,
): Promise<{ google: string | null; microsoft: string | null }> {
  const { data, error } = await client
    .from('user_oauth_tokens')
    .select('provider, refresh_token')
    .eq('user_id', userId);
  if (error) {
    console.warn('[delete-account] load tokens failed:', error.message);
    return { google: null, microsoft: null };
  }
  const rows = (data ?? []) as Array<{ provider: string; refresh_token: string }>;
  return {
    google: rows.find((r) => r.provider === 'google')?.refresh_token ?? null,
    microsoft: rows.find((r) => r.provider === 'microsoft')?.refresh_token ?? null,
  };
}

async function revokeGoogle(refreshToken: string | null): Promise<Revocation> {
  if (!refreshToken) return 'skipped';
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
    // Google returns 200 on success, 400 for already-revoked/invalid tokens.
    // Both are fine for our purposes — the grant is no longer usable.
    return res.ok || res.status === 400 ? 'ok' : 'failed';
  } catch (err) {
    console.warn('[delete-account] google revoke threw:', err);
    return 'failed';
  }
}

async function deleteUserRows(
  client: SupabaseClient,
  userId: string,
): Promise<Record<string, number | 'error'>> {
  const tables = ['push_tokens', 'mail_watchers', 'user_oauth_tokens'];
  const counts: Record<string, number | 'error'> = {};
  for (const table of tables) {
    const { error, count } = await client
      .from(table)
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    if (error) {
      console.warn(`[delete-account] delete from ${table} failed: ${error.message}`);
      counts[table] = 'error';
    } else {
      counts[table] = count ?? 0;
    }
  }
  return counts;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
