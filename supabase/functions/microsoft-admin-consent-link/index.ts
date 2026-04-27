// supabase/functions/microsoft-admin-consent-link/index.ts
//
// Issues a signed Microsoft admin-consent URL on behalf of the calling user.
// JWT-gated; the requesting user is the granting_user_id we associate with
// the eventual consented_tenants row and notify on success.
//
// Request body:
//   { tenant_domain: string, tenant_id?: string }
//
// If tenant_id is omitted we resolve it via OIDC discovery against the
// supplied tenant_domain (and cache the result). If discovery fails we
// fall back to 'common' — Microsoft will route to the user's home tenant
// when the admin signs in, but the resulting URL is less precise.
//
// Response:
//   { url: string, tenant_id: string }
//
// Error responses:
//   400 bad-request    — body shape invalid
//   401 unauthorized   — missing/invalid JWT
//   500 internal       — env or server error

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildAdminConsentUrl,
  logEvent,
  resolveTenantId,
  signState,
} from '../_shared/admin-consent.ts';

type ReqBody = { tenant_domain?: unknown; tenant_id?: unknown };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const stateSecret = Deno.env.get('ADMIN_CONSENT_STATE_SECRET');
  const msClientId = Deno.env.get('MICROSOFT_OAUTH_CLIENT_ID');
  const callbackUrl = Deno.env.get('ADMIN_CONSENT_REDIRECT_URI');
  if (!supabaseUrl || !serviceKey || !anonKey || !stateSecret || !msClientId || !callbackUrl) {
    console.error('[admin-consent-link] missing env');
    return json({ error: 'internal' }, 500);
  }

  // JWT gate.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'unauthorized' }, 401);
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ error: 'bad-request' }, 400);
  }
  const tenantDomain =
    typeof body.tenant_domain === 'string' ? body.tenant_domain.trim().toLowerCase() : '';
  if (!tenantDomain) return json({ error: 'bad-request', detail: 'tenant_domain required' }, 400);

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let tenantId =
    typeof body.tenant_id === 'string' && /^[0-9a-f-]{32,40}$/i.test(body.tenant_id)
      ? body.tenant_id
      : null;
  if (!tenantId) {
    tenantId = await resolveTenantId(service, tenantDomain);
  }
  // Fallback to 'common'. Microsoft will route to the admin's home tenant on
  // sign-in. We log this so we can spot tenants where discovery failed.
  const effectiveTenantId = tenantId ?? 'common';

  const state = await signState(
    {
      requesting_user_id: userId,
      tenant_domain: tenantDomain,
      issued_at: Date.now(),
    },
    stateSecret,
  );

  const url = buildAdminConsentUrl({
    tenantId: effectiveTenantId,
    clientId: msClientId,
    redirectUri: callbackUrl,
    state,
  });

  await logEvent(service, {
    event_type: 'admin_link_generated',
    tenant_id: tenantId ?? undefined,
    tenant_domain: tenantDomain,
    user_id: userId,
    details: { used_common_fallback: tenantId === null },
  });

  return json({ url, tenant_id: effectiveTenantId });
});
