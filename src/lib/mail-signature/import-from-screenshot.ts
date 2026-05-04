// src/lib/mail-signature/import-from-screenshot.ts
//
// Vision-based signature import. Pure validation + error mapping live here;
// the picker/Claude orchestrator (pickAndExtractSignature) lives below.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { ClaudeRateLimitError, ClaudeConfigError, completeJson } from '../claude';

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

// --- Orchestrator (impure: image picker + Claude vision call) ---

const VISION_MAX_DIMENSION = 1024;
const VISION_MAX_BASE64_LEN = 300_000;

const SIGNATURE_EXTRACT_SYSTEM_PROMPT = `You extract structured contact info from a screenshot of an email signature.
Return ONLY a JSON object with these exact keys, all strings:
  name, title, company, phone, email, website, customLines

Rules:
- If a field is not visible in the screenshot, return an empty string ("").
- Do NOT invent or guess data not visible in the screenshot.
- "name" is the person's name (e.g. "Albert Hangaard").
- "title" is their job title (e.g. "CEO", "Co-Founder").
- "company" is the organization name.
- "phone" is the most prominent phone number, formatted as shown.
- "email" is the most prominent email address.
- "website" is the URL without "https://" prefix (e.g. "zolva.io").
- "customLines" captures anything else relevant — disclaimers, addresses,
  multiple phone numbers, secondary fields — joined with newlines. Empty
  if nothing else.
- Ignore decorative elements: logos, social icons, "Kind regards", action
  buttons.`;

const SCHEMA_HINT =
  '{ "name": string, "title": string, "company": string, "phone": string, "email": string, "website": string, "customLines": string }';

export async function pickAndExtractSignature(): Promise<ImportResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: 'permission-denied' };

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'] as ImagePicker.MediaType[],
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (picked.canceled || !picked.assets || picked.assets.length === 0) {
    return { ok: false, reason: 'cancelled' };
  }

  const asset = picked.assets[0];
  let base64: string;
  let manipulatedUri: string | null = null;
  try {
    const longSide = Math.max(asset.width ?? 0, asset.height ?? 0);
    const scale = longSide > VISION_MAX_DIMENSION ? VISION_MAX_DIMENSION / longSide : 1;
    const targetWidth = Math.round((asset.width ?? VISION_MAX_DIMENSION) * scale);
    const targetHeight = Math.round((asset.height ?? VISION_MAX_DIMENSION) * scale);

    const manipulated = await manipulateAsync(
      asset.uri,
      [{ resize: { width: targetWidth, height: targetHeight } }],
      { compress: 0.85, format: SaveFormat.JPEG, base64: true },
    );
    manipulatedUri = manipulated.uri;
    base64 = manipulated.base64 ?? '';
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
  if (manipulatedUri) {
    // Best-effort tmp-file cleanup. Failures are silent.
    try { await FileSystem.deleteAsync(manipulatedUri, { idempotent: true }); } catch {}
  }
  if (!base64) return { ok: false, reason: 'parse-failed' };
  if (base64.length > VISION_MAX_BASE64_LEN) return { ok: false, reason: 'too-large' };

  let parsed: unknown;
  try {
    parsed = await completeJson<unknown>({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 400,
      system: SIGNATURE_EXTRACT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: 'Extract the signature fields from this screenshot. Return JSON only.' },
          ],
        },
      ],
      schemaHint: SCHEMA_HINT,
    });
  } catch (err) {
    return mapClaudeError(err);
  }

  return validateExtracted(parsed);
}
