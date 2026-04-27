// supabase/functions/microsoft-admin-consent-callback/index.ts
//
// Public callback endpoint Microsoft redirects an admin to after they grant
// (or deny) consent for the Zolva app on behalf of their organization. The
// admin is NOT signed in to Zolva; the only authentication is the HMAC-signed
// `state` token we issued in microsoft-admin-consent-link.
//
// Deploy with --no-verify-jwt. Per-IP rate limit is generous (60/hour) — the
// real defense is HMAC state verification.
//
// On admin_consent=True + valid state:
//   - upsert consented_tenants
//   - log admin_consent_granted
//   - best-effort push notification to the granting user
//   - render Danish thank-you HTML
//
// On error or invalid state: log + render Danish error HTML.
//
// Microsoft callback shape (success):
//   GET ?tenant=<guid>&admin_consent=True&state=<our-signed-state>
// On error:
//   GET ?error=<code>&error_description=<desc>&state=<our-signed-state>

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  StateInvalidError,
  logEvent,
  verifyState,
} from '../_shared/admin-consent.ts';

const RATE_LIMIT_PER_IP = 60; // per hour
const ipHits = new Map<string, { count: number; resetAt: number }>();

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || entry.resetAt <= now) {
    ipHits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_PER_IP) return false;
  entry.count += 1;
  return true;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const HTML_HEAD = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zolva — Godkendelse</title>
<style>
  :root { --ink:#1a1a1a; --paper:#ebe3d7; --sage:#5c7355; --warn:#8a3a3a; }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:var(--paper); color:var(--ink); }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 64px 24px; }
  h1 { font: 600 28px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0 0 16px; letter-spacing: -0.5px; }
  p { margin: 0 0 12px; }
  .accent { color: var(--sage); }
  .warn { color: var(--warn); }
  a { color: var(--sage); }
  small { color: #666; }
</style>
</head>
<body><main>`;

const HTML_FOOT = `</main></body></html>`;

function htmlResponse(body: string, status = 200): Response {
  return new Response(`${HTML_HEAD}${body}${HTML_FOOT}`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function successPage(tenantDomain: string): string {
  return `
    <h1 class="accent">Tak. Zolva er godkendt.</h1>
    <p>Brugere i organisationen <strong>${escapeHtml(tenantDomain)}</strong> kan nu forbinde deres Microsoft-konti til Zolva.</p>
    <p><small>Du behøver ikke gøre mere. Du kan lukke vinduet.</small></p>
    <p style="margin-top:24px;"><a href="https://zolva.io">Tilbage til zolva.io</a></p>
  `;
}

function errorPage(message: string): string {
  return `
    <h1 class="warn">Godkendelsen kunne ikke gennemføres</h1>
    <p>${escapeHtml(message)}</p>
    <p style="margin-top:24px;"><small>Hvis du tror dette er en fejl, kontakt os på <a href="mailto:hej@zolva.io">hej@zolva.io</a>.</small></p>
  `;
}

serve(async (req) => {
  if (req.method !== 'GET') return htmlResponse(errorPage('Forkert HTTP-metode.'), 405);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  if (!rateLimitOk(ip)) {
    return htmlResponse(errorPage('For mange forsøg. Prøv igen senere.'), 429);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const stateSecret = Deno.env.get('ADMIN_CONSENT_STATE_SECRET');
  if (!supabaseUrl || !serviceKey || !stateSecret) {
    console.error('[admin-consent-callback] missing env');
    return htmlResponse(errorPage('Serverfejl. Prøv igen senere.'), 500);
  }
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const url = new URL(req.url);
  const tenantParam = url.searchParams.get('tenant');
  const adminConsent = url.searchParams.get('admin_consent');
  const stateRaw = url.searchParams.get('state');
  const errorCode = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description');

  await logEvent(client, {
    event_type: 'admin_callback_received',
    tenant_id: tenantParam ?? undefined,
    error_code: errorCode ?? undefined,
    error_description: errorDesc ?? undefined,
    details: { admin_consent: adminConsent ?? null, ip },
  });

  // Verify state regardless of outcome — we want to attribute failures to
  // the requesting user when we can.
  if (!stateRaw) {
    await logEvent(client, {
      event_type: 'state_invalid',
      tenant_id: tenantParam ?? undefined,
      error_description: 'state missing',
    });
    return htmlResponse(
      errorPage('Linket mangler signatur. Bed brugeren om at sende et nyt link.'),
      400,
    );
  }
  let payload: { requesting_user_id: string; tenant_domain: string; issued_at: number };
  try {
    payload = await verifyState(stateRaw, stateSecret);
  } catch (err) {
    const reason = err instanceof StateInvalidError ? err.reason : 'unknown';
    await logEvent(client, {
      event_type: 'state_invalid',
      tenant_id: tenantParam ?? undefined,
      error_description: reason,
    });
    return htmlResponse(
      errorPage('Linket er udløbet eller ugyldigt. Bed brugeren om at sende et nyt link.'),
      400,
    );
  }

  if (errorCode) {
    await logEvent(client, {
      event_type: 'admin_consent_failed',
      tenant_id: tenantParam ?? undefined,
      tenant_domain: payload.tenant_domain,
      user_id: payload.requesting_user_id,
      error_code: errorCode,
      error_description: errorDesc ?? undefined,
    });
    return htmlResponse(
      errorPage(`Microsoft afviste godkendelsen: ${errorDesc ?? errorCode}`),
      400,
    );
  }

  const granted = adminConsent && adminConsent.toLowerCase() === 'true';
  if (!granted || !tenantParam) {
    await logEvent(client, {
      event_type: 'admin_consent_failed',
      tenant_id: tenantParam ?? undefined,
      tenant_domain: payload.tenant_domain,
      user_id: payload.requesting_user_id,
      error_description: `unexpected callback shape (admin_consent=${adminConsent}, tenant=${tenantParam})`,
    });
    return htmlResponse(errorPage('Godkendelsen blev ikke gennemført. Prøv igen.'), 400);
  }

  const { error: upsertErr } = await client
    .from('consented_tenants')
    .upsert(
      {
        tenant_id: tenantParam,
        tenant_domain: payload.tenant_domain,
        granting_user_id: payload.requesting_user_id,
        consented_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id' },
    );
  if (upsertErr) {
    console.error('[admin-consent-callback] upsert failed:', upsertErr.message);
    await logEvent(client, {
      event_type: 'admin_consent_failed',
      tenant_id: tenantParam,
      tenant_domain: payload.tenant_domain,
      user_id: payload.requesting_user_id,
      error_description: `upsert failed: ${upsertErr.message}`,
    });
    return htmlResponse(errorPage('Vi kunne ikke gemme godkendelsen. Prøv igen.'), 500);
  }

  await logEvent(client, {
    event_type: 'admin_consent_granted',
    tenant_id: tenantParam,
    tenant_domain: payload.tenant_domain,
    user_id: payload.requesting_user_id,
  });

  // Best-effort push to the granting user. Failures here are logged but
  // don't block the success page — the consent is already saved.
  notifyGrantingUser(client, payload.requesting_user_id, payload.tenant_domain).catch((err) => {
    console.warn('[admin-consent-callback] push notify failed:', err);
  });

  return htmlResponse(successPage(payload.tenant_domain));
});

async function notifyGrantingUser(
  client: ReturnType<typeof createClient>,
  userId: string,
  tenantDomain: string,
): Promise<void> {
  const { data, error } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  if (error) {
    console.warn('[admin-consent-callback] push_tokens select:', error.message);
    return;
  }
  const tokens = (data ?? []) as Array<{ token: string }>;
  if (tokens.length === 0) return;
  const body = tokens.map((t) => ({
    to: t.token,
    title: 'Din IT-administrator har godkendt Zolva',
    body: 'Du kan nu forbinde din arbejdsmail.',
    data: { type: 'microsoftConsentGranted', tenantDomain },
    sound: 'default',
  }));
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn('[admin-consent-callback] expo push non-ok:', res.status, await res.text());
  }
}
