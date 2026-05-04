// src/lib/mail-signature/import-from-screenshot.ts
//
// Vision-based signature import. Pure validation + error mapping live here;
// the picker/Claude orchestrator (pickAndExtractSignature) is added below in
// Task 4 — until then this file exposes only the testable pure layer.

import { ClaudeRateLimitError, ClaudeConfigError } from '../claude';

export type ExtractedSignatureFields = {
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;
};

export type ImportResult =
  | { ok: true; data: ExtractedSignatureFields }
  | {
      ok: false;
      reason:
        | 'permission-denied'
        | 'cancelled'
        | 'too-large'
        | 'no-data'
        | 'parse-failed'
        | 'network'
        | 'rate-limit'
        | 'unauthorized';
    };

const REQUIRED_FIELDS = [
  'name', 'title', 'company', 'phone', 'email', 'website', 'customLines',
] as const;

export function validateExtracted(input: unknown): ImportResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'parse-failed' };
  }
  const obj = input as Record<string, unknown>;
  const data: Partial<ExtractedSignatureFields> = {};
  for (const key of REQUIRED_FIELDS) {
    const v = obj[key];
    if (typeof v !== 'string') return { ok: false, reason: 'parse-failed' };
    (data as Record<string, string>)[key] = v;
  }
  // No-data check: every field empty after trim.
  const allEmpty = REQUIRED_FIELDS.every((k) => (data[k] ?? '').trim() === '');
  if (allEmpty) return { ok: false, reason: 'no-data' };
  return { ok: true, data: data as ExtractedSignatureFields };
}

export function mapClaudeError(err: unknown): ImportResult {
  if (err instanceof ClaudeRateLimitError) return { ok: false, reason: 'rate-limit' };
  if (err instanceof ClaudeConfigError)    return { ok: false, reason: 'unauthorized' };
  // React Native fetch network failures surface as TypeError("Network request failed").
  if (err instanceof TypeError && /network/i.test(err.message)) {
    return { ok: false, reason: 'network' };
  }
  // Any other Error (including JSON.parse failures from completeJson, generic
  // 5xx wrapped as Error) → parse-failed. The user-visible message is the same
  // either way: "we couldn't read the screenshot, try again."
  return { ok: false, reason: 'parse-failed' };
}

export function importResultMessage(result: Extract<ImportResult, { ok: false }>): string {
  switch (result.reason) {
    case 'permission-denied': return 'Giv adgang til billeder i Indstillinger for at importere fra screenshot.';
    case 'cancelled':         return '';
    case 'too-large':         return 'Billedet er for stort, vælg en mindre fil.';
    case 'no-data':           return 'Vi kunne ikke aflæse felter fra dette billede. Prøv et tydeligere screenshot.';
    case 'parse-failed':      return 'Vi kunne ikke aflæse billedet. Prøv igen eller udfyld manuelt.';
    case 'network':           return 'Ingen forbindelse. Prøv igen.';
    case 'rate-limit':        return 'For mange forsøg. Prøv igen om lidt.';
    case 'unauthorized':      return 'Log ind igen for at importere.';
  }
}
