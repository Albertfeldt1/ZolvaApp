// src/lib/mail-signature/fill-fields-from-screenshot.ts
//
// Vision-based field extraction for the manual signature form. Picks an
// image, asks Claude to read the visible name/title/company/phone/email/
// website/socials, and returns a StructuredSignature ready to populate
// the form. Unlike import-from-screenshot.ts (which reproduces the
// design as HTML), this path keeps the signature in 'structured' mode
// so the user can edit the extracted fields afterwards.

import { ClaudeRateLimitError, ClaudeConfigError } from '../claude';
import type { SocialLink, SocialType, StructuredSignature } from './types';

const SOCIAL_TYPES: ReadonlyArray<SocialType> = [
  'linkedin', 'twitter', 'instagram', 'facebook',
  'tiktok', 'youtube', 'github', 'website', 'other',
];

const FILL_FIELDS_SYSTEM_PROMPT = `You read the visible content of an email-signature screenshot and extract its structured fields for an editable form.

Return values via the fill_signature_fields tool. For every field, use an empty string if it is not visible in the screenshot — do NOT guess, infer, or fabricate values that aren't shown.

Field guidance:
- name:        the person's full name as displayed
- title:       their role/title (e.g. "Founder", "Senior Designer")
- company:     the company / organization name
- phone:       the phone number including country code if shown
- email:       the email address as shown
- website:     a single primary website URL (the company homepage if multiple are shown)
- customLines: ANY remaining lines of plain-text content that don't fit the named fields above — street address, regulatory text (CVR / VAT / license numbers), tagline, pronouns, etc. Join multiple lines with a literal newline character. Skip lines that are already captured by name/title/company/phone/email/website.
- socials:     same rules as the import_signature tool — an array of { type, url } where type is one of: linkedin, twitter, instagram, facebook, tiktok, youtube, github, website, other. Use "website" only if there's a second URL distinct from the website field above. Use "other" with an optional "label" for platforms not in the list.

If the screenshot doesn't appear to be an email signature, return all empty strings and an empty socials array.`;

const FILL_TOOL = {
  name: 'fill_signature_fields',
  description: 'Output the structured fields visible in the email-signature screenshot.',
  input_schema: {
    type: 'object',
    properties: {
      name:        { type: 'string' },
      title:       { type: 'string' },
      company:     { type: 'string' },
      phone:       { type: 'string' },
      email:       { type: 'string' },
      website:     { type: 'string' },
      customLines: { type: 'string' },
      socials: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type:  { type: 'string', enum: SOCIAL_TYPES as unknown as string[] },
            url:   { type: 'string' },
            label: { type: 'string' },
          },
          required: ['type', 'url'],
        },
      },
    },
    // No required fields — every string is optional and defaults to empty.
  },
};

export type FillResult =
  | { ok: true; data: StructuredSignature }
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

type FillFields = {
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;
  socials: SocialLink[];
};

type ParseOk = { ok: true; value: FillFields };
type ParseFail = { ok: false };

const STRING_FIELDS: ReadonlyArray<keyof Omit<FillFields, 'socials'>> = [
  'name', 'title', 'company', 'phone', 'email', 'website', 'customLines',
];

export function parseFillToolUse(input: unknown): ParseOk | ParseFail {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false };
  }
  const obj = input as Record<string, unknown>;

  const out: FillFields = {
    name: '', title: '', company: '', phone: '',
    email: '', website: '', customLines: '', socials: [],
  };

  for (const k of STRING_FIELDS) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') return { ok: false };
    out[k] = v;
  }

  if (Array.isArray(obj.socials)) {
    for (const item of obj.socials) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const it = item as Record<string, unknown>;
      const type = it.type;
      const url = it.url;
      if (typeof type !== 'string') continue;
      if (typeof url !== 'string') continue;
      if (!(SOCIAL_TYPES as ReadonlyArray<string>).includes(type)) continue;
      const link: SocialLink = { type: type as SocialType, url };
      if (typeof it.label === 'string') link.label = it.label;
      out.socials.push(link);
    }
  }

  return { ok: true, value: out };
}

export function mapFillError(err: unknown): FillResult {
  if (err instanceof ClaudeRateLimitError) return { ok: false, reason: 'rate-limit' };
  if (err instanceof ClaudeConfigError) return { ok: false, reason: 'unauthorized' };
  if (err instanceof TypeError && /network/i.test(err.message)) {
    return { ok: false, reason: 'network' };
  }
  return { ok: false, reason: 'parse-failed' };
}

export function fillResultMessage(result: Extract<FillResult, { ok: false }>): string {
  switch (result.reason) {
    case 'permission-denied': return 'Giv adgang til billeder i Indstillinger for at udfylde fra screenshot.';
    case 'cancelled':         return '';
    case 'too-large':         return 'Billedet er for stort, vælg en mindre fil.';
    case 'no-data':           return 'Vi kunne ikke aflæse felter fra dette billede. Prøv et tydeligere screenshot.';
    case 'parse-failed':      return 'Vi kunne ikke aflæse billedet. Prøv igen eller udfyld manuelt.';
    case 'network':           return 'Ingen forbindelse. Prøv igen.';
    case 'rate-limit':        return 'For mange forsøg. Prøv igen om lidt.';
    case 'unauthorized':      return 'Log ind igen for at udfylde.';
  }
}

// pickAndFillFields lives in the next task — see Task 2.
