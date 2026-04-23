// Shared OAuth helpers for Supabase edge functions.
//
// Server-side refresh-token → access-token exchange for Google and Microsoft.
// Refresh tokens are stored in `user_oauth_tokens` and are service-role-only
// (no client RLS grant). These helpers assume the caller already has a
// service-role Supabase client.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Provider = 'google' | 'microsoft';

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

// For Microsoft, the refresh exchange returns a token scoped to whatever
// scopes you request. For Google, scope is ignored on refresh; the new
// access token inherits the original grant.
export type RefreshOptions = {
  microsoftScope?: string;
};

export async function refreshAccessToken(
  provider: Provider,
  refreshToken: string,
  opts: RefreshOptions = {},
): Promise<string> {
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
    if (!res.ok) throw new Error(`google refresh failed: ${res.status}`);
    const j = (await res.json()) as { access_token?: string };
    if (!j.access_token) throw new Error('google refresh missing access_token');
    return j.access_token;
  }

  const clientId = Deno.env.get('MICROSOFT_OAUTH_CLIENT_ID');
  const clientSecret = Deno.env.get('MICROSOFT_OAUTH_CLIENT_SECRET');
  const tenant = Deno.env.get('MICROSOFT_OAUTH_TENANT') ?? 'common';
  if (!clientId || !clientSecret) throw new Error('microsoft oauth env missing');
  const scope = opts.microsoftScope ?? 'offline_access Mail.ReadWrite Mail.Send';
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope,
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
  );
  if (!res.ok) throw new Error(`microsoft refresh failed: ${res.status}`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error('microsoft refresh missing access_token');
  return j.access_token;
}
