// Microsoft tenant admin-consent client helpers.
//
// Three concerns:
//   1. Detect that a Microsoft auth failure is "admin consent required"
//      from the upstream Supabase/AAD error string.
//   2. Pull the email domain from a user-supplied email so we can resolve
//      the tenant and route the admin-consent flow.
//   3. Call the microsoft-admin-consent-link edge function to mint a
//      signed admin-consent URL on the user's behalf.

import { supabase } from './supabase';

export type AdminConsentDetection =
  | { detected: false }
  | { detected: true; tenantHint?: string };

// AADSTS90094 = admin consent required for the requested permissions
// AADSTS65001 = user has not consented (often the first signal of admin-only consent)
// AADSTS900971 = no reply address / admin-consent variant
// consent_required / interaction_required = OAuth-spec error names AAD also emits
const ADMIN_CONSENT_PATTERNS: ReadonlyArray<RegExp> = [
  /aadsts(?:90094|65001|900971)/i,
  /\bconsent[_-]?required\b/i,
  /\binteraction[_-]?required\b/i,
  /admin\s*consent/i,
];

export function detectAdminConsentRequired(message: string | null | undefined): AdminConsentDetection {
  if (!message) return { detected: false };
  const hit = ADMIN_CONSENT_PATTERNS.some((re) => re.test(message));
  if (!hit) return { detected: false };
  // Best-effort tenant hint: AAD errors sometimes include the tenant or the
  // domain. We don't depend on it — the screen asks the user for their work
  // email and resolves from there.
  const domainMatch = message.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return { detected: true, tenantHint: domainMatch?.[1]?.toLowerCase() };
}

export function extractDomain(email: string): string | null {
  const at = email.indexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

export type AdminConsentLink = {
  url: string;
  tenant_id: string;
};

export type AdminConsentLinkError = {
  code: 'unauthorized' | 'bad-request' | 'network' | 'internal';
  detail?: string;
};

export async function requestAdminConsentLink(
  tenantDomain: string,
): Promise<{ ok: true; data: AdminConsentLink } | { ok: false; error: AdminConsentLinkError }> {
  try {
    const { data, error } = await supabase.functions.invoke<AdminConsentLink>(
      'microsoft-admin-consent-link',
      { body: { tenant_domain: tenantDomain } },
    );
    if (error) {
      const status = (error as unknown as { status?: number }).status;
      if (status === 401) return { ok: false, error: { code: 'unauthorized' } };
      if (status === 400) return { ok: false, error: { code: 'bad-request', detail: error.message } };
      return { ok: false, error: { code: 'internal', detail: error.message } };
    }
    if (!data?.url) {
      return { ok: false, error: { code: 'internal', detail: 'no url in response' } };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'network', detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

// One-shot snapshot of the user's email domain. Inserted with auth.uid() RLS
// gate; calling more than once is harmless (PK conflict, ignored). Errors
// are swallowed — this is telemetry, never blocking.
export async function recordUserEmailDomain(userId: string, email: string | null | undefined): Promise<void> {
  if (!userId || !email) return;
  const domain = extractDomain(email);
  if (!domain) return;
  try {
    await supabase
      .from('user_email_domains')
      .insert({ user_id: userId, email_domain: domain });
    // Conflict on PK = already recorded; not an error worth surfacing.
  } catch {
    // network / RLS edge cases; ignore.
  }
}
