// Shared helpers for the Microsoft tenant admin-consent flow.
//
// Two surfaces use this module:
//   - microsoft-admin-consent-link    (JWT-gated, signs state + builds URL)
//   - microsoft-admin-consent-callback (public, verifies state + persists)
//
// Constraints:
//   - No new dependencies. Web Crypto + fetch are sufficient.
//   - State signing uses HMAC-SHA256 over a JSON payload, base64url-encoded.
//   - Tenant-id resolution uses Microsoft's OIDC discovery endpoint and is
//     cached in tenant_id_cache to avoid hammering login.microsoftonline.com.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type StatePayload = {
  requesting_user_id: string;
  tenant_domain: string;
  issued_at: number; // ms since epoch
};

export class StateInvalidError extends Error {
  readonly kind = 'state-invalid' as const;
  readonly reason: 'malformed' | 'bad-signature' | 'expired';
  constructor(reason: 'malformed' | 'bad-signature' | 'expired') {
    super(`admin-consent state invalid: ${reason}`);
    this.reason = reason;
  }
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signState(payload: StatePayload, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const jsonBytes = new TextEncoder().encode(json);
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, jsonBytes));
  return `${bytesToBase64url(jsonBytes)}.${bytesToBase64url(sig)}`;
}

export async function verifyState(token: string, secret: string): Promise<StatePayload> {
  const parts = token.split('.');
  if (parts.length !== 2) throw new StateInvalidError('malformed');
  let jsonBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    jsonBytes = base64urlToBytes(parts[0]);
    sigBytes = base64urlToBytes(parts[1]);
  } catch {
    throw new StateInvalidError('malformed');
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, jsonBytes);
  if (!ok) throw new StateInvalidError('bad-signature');
  let parsed: StatePayload;
  try {
    parsed = JSON.parse(new TextDecoder().decode(jsonBytes)) as StatePayload;
  } catch {
    throw new StateInvalidError('malformed');
  }
  if (
    typeof parsed.requesting_user_id !== 'string' ||
    typeof parsed.tenant_domain !== 'string' ||
    typeof parsed.issued_at !== 'number'
  ) {
    throw new StateInvalidError('malformed');
  }
  if (Date.now() - parsed.issued_at > STATE_TTL_MS) {
    throw new StateInvalidError('expired');
  }
  return parsed;
}

// Resolve a Microsoft tenant ID from an email domain via OIDC discovery.
// Returns null if discovery fails (domain isn't an Entra ID tenant, or
// network/parsing error). All outcomes are logged to consent_events.
export async function resolveTenantId(
  client: SupabaseClient,
  domain: string,
): Promise<string | null> {
  const normalized = domain.trim().toLowerCase();
  if (!normalized) return null;

  const cached = await client
    .from('tenant_id_cache')
    .select('tenant_id')
    .eq('domain', normalized)
    .maybeSingle();
  if (cached.data?.tenant_id) return cached.data.tenant_id as string;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(normalized)}/v2.0/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    await logEvent(client, {
      event_type: 'tenant_lookup_failed',
      tenant_domain: normalized,
      error_description: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
  if (!res.ok) {
    await logEvent(client, {
      event_type: 'tenant_lookup_failed',
      tenant_domain: normalized,
      error_description: `discovery ${res.status}`,
    });
    return null;
  }
  const j = (await res.json().catch(() => null)) as { issuer?: string } | null;
  // issuer is "https://login.microsoftonline.com/{tenant_id}/v2.0"
  const match = j?.issuer?.match(/login\.microsoftonline\.com\/([0-9a-f-]+)\/v2\.0/i);
  if (!match) {
    await logEvent(client, {
      event_type: 'tenant_lookup_failed',
      tenant_domain: normalized,
      error_description: `issuer not parseable: ${j?.issuer ?? '(none)'}`,
    });
    return null;
  }
  const tenantId = match[1];
  await client
    .from('tenant_id_cache')
    .upsert(
      { domain: normalized, tenant_id: tenantId, cached_at: new Date().toISOString() },
      { onConflict: 'domain' },
    );
  await logEvent(client, {
    event_type: 'tenant_lookup',
    tenant_id: tenantId,
    tenant_domain: normalized,
  });
  return tenantId;
}

export type ConsentEvent = {
  event_type:
    | 'user_blocked'
    | 'admin_link_generated'
    | 'admin_callback_received'
    | 'admin_consent_granted'
    | 'admin_consent_failed'
    | 'state_invalid'
    | 'tenant_lookup'
    | 'tenant_lookup_failed';
  tenant_id?: string;
  tenant_domain?: string;
  user_id?: string;
  error_code?: string;
  error_description?: string;
  details?: Record<string, unknown>;
};

export async function logEvent(client: SupabaseClient, event: ConsentEvent): Promise<void> {
  const { error } = await client.from('consent_events').insert({
    event_type: event.event_type,
    tenant_id: event.tenant_id ?? null,
    tenant_domain: event.tenant_domain ?? null,
    user_id: event.user_id ?? null,
    error_code: event.error_code ?? null,
    error_description: event.error_description ?? null,
    details: event.details ?? null,
  });
  if (error) {
    console.warn('[admin-consent] logEvent failed:', error.message);
  }
}

// Construct the Microsoft admin consent URL. Caller is responsible for
// ensuring tenantId is resolved (or 'common' as fallback) and state is
// signed. redirectUri must be registered in the Azure AD app registration.
export function buildAdminConsentUrl(input: {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(input.tenantId)}/adminconsent?${params.toString()}`;
}
