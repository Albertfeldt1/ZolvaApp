// Shared OAuth helpers for Supabase edge functions.
//
// Server-side refresh-token → access-token exchange for Google and Microsoft.
// Refresh tokens are stored in `user_oauth_tokens` and are service-role-only
// (no client RLS grant). These helpers assume the caller already has a
// service-role Supabase client.
//
// Microsoft's v2.0 endpoint rotates refresh_tokens on every refresh: the new
// access_token comes back together with a new refresh_token, and the old one
// will eventually be invalidated. We persist the rotated value here so that
// concurrent callers (poll-mail cron, daily-brief, client silentRefresh) can't
// invalidate each other's stored grant. Skipping this caused the iOS hourly
// re-login dialog for Outlook users.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Provider = 'google' | 'microsoft';

export class RefreshRejectedError extends Error {
  readonly kind = 'refresh-rejected' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RefreshRejectedError';
  }
}

export type RefreshOptions = {
  microsoftScope?: string;
};

export type RefreshResult = {
  accessToken: string;
  expiresIn: number;
};

const DEFAULT_MICROSOFT_SCOPE = 'offline_access Mail.ReadWrite Mail.Send';

export async function loadRefreshToken(
  client: SupabaseClient,
  userId: string,
  provider: Provider,
): Promise<string | null> {
  const { data, error } = await client
    .from('user_oauth_tokens')
    .select('refresh_token')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) {
    console.warn('[oauth] load refresh token failed:', error.message);
    return null;
  }
  return (data as { refresh_token?: string } | null)?.refresh_token ?? null;
}

// Single structured log line emitted from `refreshAccessToken` on every exit
// path (success or thrown). Greppable in production via `[oauth-refresh]`.
// Pure instrumentation — does not change control flow or persist behavior.
//
// Note: a successful refresh emits TWO [oauth-refresh] lines — one here
// (no `layer` field) and one from refresh-provider-token (layer: 'edge').
// When grepping logs, distinguish by the `layer` field. Expect ~2x line
// count vs. request count for the success path.
type RefreshLogCtx = {
  provider: Provider;
  userId: string;
  scope: string;
  tokenAgeS: number | null;
  mintStatus: number | null;
  rotation: 'rotated' | 'same' | 'missing' | 'unknown';
  persist: 'ok' | 'failed' | 'na';
  persistError: string | null;
  outcome:
    | 'success'
    | 'refresh_rejected'
    | 'scope_rejected'
    | 'network'
    | 'pending';
  elapsedMs: number;
};

function emitRefreshLog(ctx: RefreshLogCtx): void {
  console.log('[oauth-refresh]', JSON.stringify(ctx));
}

async function loadRefreshTokenAgeS(
  client: SupabaseClient,
  userId: string,
  provider: Provider,
): Promise<number | null> {
  const { data, error } = await client
    .from('user_oauth_tokens')
    .select('updated_at')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error || !data?.updated_at) return null;
  const updatedAtMs = Date.parse(data.updated_at as string);
  if (Number.isNaN(updatedAtMs)) return null;
  return Math.round((Date.now() - updatedAtMs) / 1000);
}

export async function refreshAccessToken(
  client: SupabaseClient,
  userId: string,
  provider: Provider,
  refreshToken: string,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const startedAt = Date.now();
  const ctx: RefreshLogCtx = {
    provider,
    userId: userId.slice(0, 8),
    scope:
      provider === 'microsoft'
        ? opts.microsoftScope ?? DEFAULT_MICROSOFT_SCOPE
        : 'google-default',
    tokenAgeS: null,
    mintStatus: null,
    rotation: 'unknown',
    persist: 'na',
    persistError: null,
    outcome: 'pending',
    elapsedMs: 0,
  };

  try {
    ctx.tokenAgeS = await loadRefreshTokenAgeS(client, userId, provider);

    const minted = await mintAccessToken(provider, refreshToken, opts, ctx);

    if (!minted.rotatedRefreshToken) {
      ctx.rotation = 'missing';
    } else if (minted.rotatedRefreshToken === refreshToken) {
      ctx.rotation = 'same';
    } else {
      ctx.rotation = 'rotated';
      const persistResult = await persistRefreshToken(
        client,
        userId,
        provider,
        minted.rotatedRefreshToken,
      );
      if (persistResult.ok) {
        ctx.persist = 'ok';
      } else {
        ctx.persist = 'failed';
        // Truncate: PG error strings can include row data via `detail` for
        // some constraints, and we don't want a refresh_token fragment
        // landing in logs. 200 chars keeps standard messages intact.
        ctx.persistError = persistResult.error?.slice(0, 200) ?? null;
      }
    }

    ctx.outcome = 'success';
    return { accessToken: minted.accessToken, expiresIn: minted.expiresIn };
  } catch (err) {
    if (err instanceof RefreshRejectedError) {
      ctx.outcome = 'refresh_rejected';
    } else if (
      err instanceof Error &&
      /invalid_scope|consent_required/i.test(err.message)
    ) {
      ctx.outcome = 'scope_rejected';
    } else {
      ctx.outcome = 'network';
    }
    throw err;
  } finally {
    ctx.elapsedMs = Date.now() - startedAt;
    emitRefreshLog(ctx);
  }
}

type PersistResult = { ok: true } | { ok: false; error: string };

async function persistRefreshToken(
  client: SupabaseClient,
  userId: string,
  provider: Provider,
  refreshToken: string,
): Promise<PersistResult> {
  const { error } = await client.from('user_oauth_tokens').upsert(
    {
      user_id: userId,
      provider,
      refresh_token: refreshToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

type MintedToken = {
  accessToken: string;
  expiresIn: number;
  rotatedRefreshToken?: string;
};

async function mintAccessToken(
  provider: Provider,
  refreshToken: string,
  opts: RefreshOptions,
  ctx?: RefreshLogCtx,
): Promise<MintedToken> {
  if (provider === 'google') {
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !clientSecret) throw new Error('google oauth env missing');
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (ctx) ctx.mintStatus = res.status;
    return parseTokenResponse('google', res);
  }

  const clientId = Deno.env.get('MICROSOFT_OAUTH_CLIENT_ID');
  const clientSecret = Deno.env.get('MICROSOFT_OAUTH_CLIENT_SECRET');
  const tenant = Deno.env.get('MICROSOFT_OAUTH_TENANT') ?? 'common';
  if (!clientId || !clientSecret) throw new Error('microsoft oauth env missing');
  const scope = opts.microsoftScope ?? DEFAULT_MICROSOFT_SCOPE;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope,
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (ctx) ctx.mintStatus = res.status;
  return parseTokenResponse('microsoft', res);
}

async function parseTokenResponse(
  provider: Provider,
  res: Response,
): Promise<MintedToken> {
  const text = await res.text();
  if (!res.ok) {
    // Both providers return JSON error bodies; `invalid_grant` means the
    // stored refresh_token is no longer accepted (revoked, expired, or
    // rotated past us). Anything else is upstream/transient.
    if (/invalid_grant/.test(text)) {
      throw new RefreshRejectedError(`${provider} refresh rejected: ${text}`);
    }
    throw new Error(`${provider} refresh ${res.status}: ${text}`);
  }
  const j = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!j.access_token) throw new Error(`${provider} refresh missing access_token`);
  return {
    accessToken: j.access_token,
    expiresIn: j.expires_in ?? 3600,
    rotatedRefreshToken: j.refresh_token,
  };
}
