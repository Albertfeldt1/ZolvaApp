# Signature Screenshot — Three Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single "Importér fra screenshot" button into three distinct entry points: (1) auto-fill the manual form fields from a screenshot while staying in manual mode, (2) keep the existing AI HTML reproduction, (3) embed the screenshot itself as the signature with no AI call.

**Architecture:** Two new modules under `src/lib/mail-signature/`. `fill-fields-from-screenshot.ts` mirrors `import-from-screenshot.ts` but uses a different vision tool (`fill_signature_fields`) that returns structured fields. `use-screenshot.ts` is a no-AI helper that picks an image, compresses it, and wraps it in a single-`<img>` `ImportedSignature`. `MailSignatureSection` in `SettingsScreen.tsx` gets two new buttons and corresponding handlers.

**Tech Stack:** React Native (Expo), TypeScript, Jest, expo-image-picker, expo-image-manipulator, internal `completeWithTool` Claude wrapper.

**Spec:** `docs/superpowers/specs/2026-05-05-signature-screenshot-three-paths-design.md`

---

## File map

| Path | Action | Purpose |
|---|---|---|
| `src/lib/mail-signature/fill-fields-from-screenshot.ts` | CREATE | Vision tool + picker that extracts structured fields |
| `src/lib/mail-signature/__tests__/fill-fields-from-screenshot.test.ts` | CREATE | Unit tests for the parser + error mapper |
| `src/lib/mail-signature/use-screenshot.ts` | CREATE | No-AI picker that wraps the screenshot as an ImportedSignature |
| `src/lib/mail-signature/__tests__/use-screenshot.test.ts` | CREATE | Unit tests for the html-builder helper |
| `src/lib/mail-signature/index.ts` | MODIFY | Re-export the new public functions and types |
| `src/screens/SettingsScreen.tsx` | MODIFY | Add the two new buttons + handlers in `MailSignatureSection` |

---

## Task 1: Pure helpers + parser for `fill-fields-from-screenshot`

**Files:**
- Create: `src/lib/mail-signature/fill-fields-from-screenshot.ts`
- Test:   `src/lib/mail-signature/__tests__/fill-fields-from-screenshot.test.ts`

This task scaffolds the module with everything that doesn't touch the Expo runtime: the parser, the error mapper, and the Danish error-message helper. The picker itself comes in Task 2.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/mail-signature/__tests__/fill-fields-from-screenshot.test.ts

jest.mock('../../claude', () => {
  class ClaudeRateLimitErrorMock extends Error {
    readonly retryAfterSec: number;
    readonly reason: 'rpm' | 'daily';
    constructor(retryAfterSec: number, reason: 'rpm' | 'daily') {
      super('rate limit');
      this.name = 'ClaudeRateLimitError';
      this.retryAfterSec = retryAfterSec;
      this.reason = reason;
    }
  }
  class ClaudeConfigErrorMock extends Error {
    constructor() {
      super('config');
      this.name = 'ClaudeConfigError';
    }
  }
  return {
    ClaudeRateLimitError: ClaudeRateLimitErrorMock,
    ClaudeConfigError: ClaudeConfigErrorMock,
    completeWithTool: jest.fn(),
  };
});

import {
  parseFillToolUse,
  mapFillError,
  fillResultMessage,
} from '../fill-fields-from-screenshot';
import { ClaudeRateLimitError, ClaudeConfigError } from '../../claude';

describe('parseFillToolUse', () => {
  const ok = {
    name: 'Albert Feldt',
    title: 'Founder',
    company: 'Zolva',
    phone: '+45 12 34 56 78',
    email: 'albert@zolva.io',
    website: 'zolva.io',
    customLines: 'CVR 12345678\nCopenhagen, DK',
    socials: [],
  };

  it('accepts a valid response with all fields populated', () => {
    expect(parseFillToolUse(ok)).toEqual({ ok: true, value: ok });
  });

  it('treats missing strings as empty strings', () => {
    const partial = { name: 'A', title: 'T' };
    const out = parseFillToolUse(partial);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toEqual({
        name: 'A',
        title: 'T',
        company: '',
        phone: '',
        email: '',
        website: '',
        customLines: '',
        socials: [],
      });
    }
  });

  it('coerces missing socials to []', () => {
    const out = parseFillToolUse({ name: 'A' });
    expect(out.ok && out.value.socials).toEqual([]);
  });

  it('drops socials with bad type or non-string url', () => {
    const input = {
      name: '',
      socials: [
        { type: 'linkedin', url: 'https://linkedin.com/in/a' },
        { type: 'invalid',  url: 'https://x.com' },
        { type: 'github' },
        { type: 'twitter', url: 42 },
      ],
    };
    const out = parseFillToolUse(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.socials).toEqual([
        { type: 'linkedin', url: 'https://linkedin.com/in/a' },
      ]);
    }
  });

  it('rejects non-object inputs', () => {
    expect(parseFillToolUse(null)).toEqual({ ok: false });
    expect(parseFillToolUse('string')).toEqual({ ok: false });
    expect(parseFillToolUse(42)).toEqual({ ok: false });
    expect(parseFillToolUse([])).toEqual({ ok: false });
  });

  it('rejects when a present field has the wrong type', () => {
    const bad = { name: 42 };
    expect(parseFillToolUse(bad)).toEqual({ ok: false });
  });
});

describe('mapFillError', () => {
  it('maps ClaudeRateLimitError to rate-limit', () => {
    expect(mapFillError(new ClaudeRateLimitError(60, 'rpm'))).toEqual({ ok: false, reason: 'rate-limit' });
  });
  it('maps ClaudeConfigError to unauthorized', () => {
    expect(mapFillError(new ClaudeConfigError())).toEqual({ ok: false, reason: 'unauthorized' });
  });
  it('maps a TypeError network failure to network', () => {
    expect(mapFillError(new TypeError('Network request failed'))).toEqual({ ok: false, reason: 'network' });
  });
  it('maps unknown errors to parse-failed', () => {
    expect(mapFillError(new Error('boom'))).toEqual({ ok: false, reason: 'parse-failed' });
    expect(mapFillError('string')).toEqual({ ok: false, reason: 'parse-failed' });
  });
});

describe('fillResultMessage', () => {
  it('returns Danish messages for each failure reason', () => {
    expect(fillResultMessage({ ok: false, reason: 'permission-denied' })).toContain('Indstillinger');
    expect(fillResultMessage({ ok: false, reason: 'cancelled' })).toBe('');
    expect(fillResultMessage({ ok: false, reason: 'too-large' })).toContain('for stort');
    expect(fillResultMessage({ ok: false, reason: 'no-data' })).toContain('felter');
    expect(fillResultMessage({ ok: false, reason: 'parse-failed' })).toContain('aflæse');
    expect(fillResultMessage({ ok: false, reason: 'network' })).toContain('forbindelse');
    expect(fillResultMessage({ ok: false, reason: 'rate-limit' })).toContain('forsøg');
    expect(fillResultMessage({ ok: false, reason: 'unauthorized' })).toContain('Log ind');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/lib/mail-signature/__tests__/fill-fields-from-screenshot.test.ts -t parseFillToolUse`

Expected: FAIL with module-not-found or "parseFillToolUse is not a function".

- [ ] **Step 3: Implement the module (parser + error helpers + tool definition)**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/lib/mail-signature/__tests__/fill-fields-from-screenshot.test.ts`

Expected: PASS — all parseFillToolUse / mapFillError / fillResultMessage cases green.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mail-signature/fill-fields-from-screenshot.ts src/lib/mail-signature/__tests__/fill-fields-from-screenshot.test.ts
git commit -m "feat(mail-signature): scaffold fill-fields parser + error helpers"
```

---

## Task 2: Implement `pickAndFillFields` orchestrator

**Files:**
- Modify: `src/lib/mail-signature/fill-fields-from-screenshot.ts` (replace the placeholder body)

The orchestrator depends on Expo runtime and the live Claude call, so we don't add a unit test for it — the parsers are already covered, and we'll verify the full path manually after wiring up the UI.

- [ ] **Step 1: Add Expo runtime imports + the `completeWithTool` import + `EMPTY_SIGNATURE`**

Find the existing import block at the top of `src/lib/mail-signature/fill-fields-from-screenshot.ts`:

```typescript
import { ClaudeRateLimitError, ClaudeConfigError } from '../claude';
import type { SocialLink, SocialType, StructuredSignature } from './types';
```

Replace with:

```typescript
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { ClaudeRateLimitError, ClaudeConfigError, completeWithTool } from '../claude';
import { EMPTY_SIGNATURE, type SocialLink, type SocialType, type StructuredSignature } from './types';
```

Also add the two size constants near the top of the file (above `SOCIAL_TYPES`):

```typescript
const VISION_MAX_DIMENSION = 1024;
const VISION_MAX_BASE64_LEN = 300_000;
```

- [ ] **Step 2: Append the `pickAndFillFields` orchestrator at the bottom of the file**

After the existing `fillResultMessage` function (replacing the comment line `// pickAndFillFields lives in the next task — see Task 2.`):

```typescript
export async function pickAndFillFields(): Promise<FillResult> {
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
  let resizedUri: string | null = null;
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
    resizedUri = manipulated.uri;
    base64 = manipulated.base64 ?? '';
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
  if (!base64 || !resizedUri) return { ok: false, reason: 'parse-failed' };
  if (base64.length > VISION_MAX_BASE64_LEN) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return { ok: false, reason: 'too-large' };
  }

  let toolInput: unknown;
  try {
    toolInput = await completeWithTool<unknown>({
      model: 'claude-sonnet-4-6',
      maxTokens: 1200,
      system: FILL_FIELDS_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: 'Extract the structured fields you can see using the fill_signature_fields tool.' },
          ],
        },
      ],
      tool: FILL_TOOL,
      attachProfile: false,
    });
  } catch (err) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return mapFillError(err);
  }

  try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}

  const parsed = parseFillToolUse(toolInput);
  if (!parsed.ok) return { ok: false, reason: 'parse-failed' };

  const v = parsed.value;
  // Guard against an all-empty response — that's "no signature visible".
  const anyText = v.name || v.title || v.company || v.phone || v.email || v.website || v.customLines;
  if (!anyText && v.socials.length === 0) {
    return { ok: false, reason: 'no-data' };
  }

  const data: StructuredSignature = {
    ...EMPTY_SIGNATURE,
    name: v.name,
    title: v.title,
    company: v.company,
    phone: v.phone,
    email: v.email,
    website: v.website,
    customLines: v.customLines,
    socials: v.socials,
    // Logo is preserved by the caller (we don't carry it through the vision call).
  };
  return { ok: true, data };
}
```

- [ ] **Step 3: Run all signature tests to make sure nothing regressed**

Run: `npx jest src/lib/mail-signature/`

Expected: PASS (existing test counts + the new fill-fields tests all green).

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail-signature/fill-fields-from-screenshot.ts
git commit -m "feat(mail-signature): vision call + picker for field auto-fill"
```

---

## Task 3: `use-screenshot.ts` — image-only signature

**Files:**
- Create: `src/lib/mail-signature/use-screenshot.ts`
- Test:   `src/lib/mail-signature/__tests__/use-screenshot.test.ts`

No AI involved: pick an image, compress, wrap as an `ImportedSignature` whose html is just a single `<img>`. We test the html builder directly; the picker is exercised manually.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/mail-signature/__tests__/use-screenshot.test.ts

import { buildImageOnlySignature, useScreenshotResultMessage } from '../use-screenshot';
import type { InlineImage } from '../types';

describe('buildImageOnlySignature', () => {
  const img: InlineImage = {
    base64: 'AAAA',
    mimeType: 'image/jpeg',
    width: 600,
    height: 200,
  };

  it('returns kind=imported with the inline image', () => {
    const sig = buildImageOnlySignature(img, 1700000000000);
    expect(sig.kind).toBe('imported');
    expect(sig.image).toBe(img);
    expect(sig.importedAt).toBe(1700000000000);
    expect(sig.socials).toEqual([]);
    expect(sig.plaintext).toBe('');
  });

  it('produces html that is a single cid:zolva-sig image wrapped in a table', () => {
    const sig = buildImageOnlySignature(img, 0);
    expect(sig.html).toContain('<table');
    expect(sig.html).toContain('src="cid:zolva-sig"');
    expect(sig.html).toContain('max-width:600px');
    // No other content beyond the image cell.
    expect(sig.html).not.toMatch(/<p\b/);
  });
});

describe('useScreenshotResultMessage', () => {
  it('returns Danish messages for each failure reason', () => {
    expect(useScreenshotResultMessage({ ok: false, reason: 'permission-denied' })).toContain('Indstillinger');
    expect(useScreenshotResultMessage({ ok: false, reason: 'cancelled' })).toBe('');
    expect(useScreenshotResultMessage({ ok: false, reason: 'too-large' })).toContain('for stort');
    expect(useScreenshotResultMessage({ ok: false, reason: 'parse-failed' })).toContain('billedet');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/lib/mail-signature/__tests__/use-screenshot.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
// src/lib/mail-signature/use-screenshot.ts
//
// "Brug screenshot direkte" — picks an image, compresses it, and wraps
// it as an ImportedSignature whose html is a single <img src="cid:zolva-sig">.
// No AI call. Trade-off: pixel-perfect fidelity vs. no text-selection /
// no per-element link binding. The user opts in.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import type { ImportedSignature, InlineImage } from './types';

const MAX_DIMENSION = 1024;
const MAX_BASE64_LEN = 300_000;

export type UseScreenshotResult =
  | { ok: true; data: ImportedSignature }
  | { ok: false; reason: 'permission-denied' | 'cancelled' | 'too-large' | 'parse-failed' };

export function buildImageOnlySignature(image: InlineImage, importedAt: number): ImportedSignature {
  // display:block + max-width keeps the screenshot from breaking the
  // layout in narrow Outlook panes; height:auto preserves aspect ratio.
  // alt="" because the image IS the signature — there's no separate
  // text version that would benefit from a redundant alt.
  const html =
    `<table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse">` +
    `<tr><td style="padding:0">` +
    `<img src="cid:zolva-sig" style="display:block;max-width:600px;width:100%;height:auto" alt="">` +
    `</td></tr></table>`;
  return {
    kind: 'imported',
    html,
    plaintext: '',
    image,
    importedAt,
    socials: [],
  };
}

export function useScreenshotResultMessage(result: Extract<UseScreenshotResult, { ok: false }>): string {
  switch (result.reason) {
    case 'permission-denied': return 'Giv adgang til billeder i Indstillinger for at bruge et screenshot.';
    case 'cancelled':         return '';
    case 'too-large':         return 'Billedet er for stort, vælg en mindre fil.';
    case 'parse-failed':      return 'Kunne ikke læse billedet. Prøv et andet.';
  }
}

export async function pickAndUseScreenshot(): Promise<UseScreenshotResult> {
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
  const isPng = (asset.mimeType ?? '').toLowerCase() === 'image/png'
    || asset.uri.toLowerCase().endsWith('.png');

  try {
    const longSide = Math.max(asset.width ?? 0, asset.height ?? 0);
    const scale = longSide > MAX_DIMENSION ? MAX_DIMENSION / longSide : 1;
    const targetWidth = Math.round((asset.width ?? MAX_DIMENSION) * scale);
    const targetHeight = Math.round((asset.height ?? MAX_DIMENSION) * scale);

    const manipulated = await manipulateAsync(
      asset.uri,
      [{ resize: { width: targetWidth, height: targetHeight } }],
      {
        compress: isPng ? 1 : 0.85,
        format: isPng ? SaveFormat.PNG : SaveFormat.JPEG,
        base64: true,
      },
    );

    const base64 = manipulated.base64 ?? '';
    if (!base64) return { ok: false, reason: 'parse-failed' };
    if (base64.length > MAX_BASE64_LEN) {
      try { await FileSystem.deleteAsync(manipulated.uri, { idempotent: true }); } catch {}
      return { ok: false, reason: 'too-large' };
    }

    try { await FileSystem.deleteAsync(manipulated.uri, { idempotent: true }); } catch {}

    const image: InlineImage = {
      base64,
      mimeType: isPng ? 'image/png' : 'image/jpeg',
      width: manipulated.width ?? targetWidth,
      height: manipulated.height ?? targetHeight,
    };
    return { ok: true, data: buildImageOnlySignature(image, Date.now()) };
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/lib/mail-signature/__tests__/use-screenshot.test.ts`

Expected: PASS — all four assertions green.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mail-signature/use-screenshot.ts src/lib/mail-signature/__tests__/use-screenshot.test.ts
git commit -m "feat(mail-signature): no-AI image-only signature path"
```

---

## Task 4: Re-export new functions from the barrel

**Files:**
- Modify: `src/lib/mail-signature/index.ts`

- [ ] **Step 1: Add the new exports**

Open `src/lib/mail-signature/index.ts` and append after the existing `import-from-screenshot` export block:

```typescript
export {
  pickAndFillFields,
  fillResultMessage,
} from './fill-fields-from-screenshot';
export type { FillResult } from './fill-fields-from-screenshot';

export {
  pickAndUseScreenshot,
  useScreenshotResultMessage,
  buildImageOnlySignature,
} from './use-screenshot';
export type { UseScreenshotResult } from './use-screenshot';
```

The full file should look like:

```typescript
// src/lib/mail-signature/index.ts
//
// Public API for the rich mail signature module. Internal files import
// from each other directly; everywhere else imports from this barrel.

export type {
  SignatureData,
  StructuredSignature,
  ImportedSignature,
  InlineImage,
  RenderedSignature,
  InlineAttachmentSpec,
  SocialLink,
  SocialType,
  LinkTarget,
} from './types';
export { EMPTY_SIGNATURE } from './types';
export { loadSignature, saveSignature, subscribeSignature } from './storage';
export { renderSignature, renderImported } from './template';
export { buildOutgoingBody } from './build-outgoing-body';
export type { OutgoingBody } from './build-outgoing-body';
export { pickAndCompressLogo, pickResultMessage } from './image';
export type { PickResult } from './image';
export {
  pickAndImportSignature,
  importResultMessage,
} from './import-from-screenshot';
export type { ImportResult } from './import-from-screenshot';
export {
  pickAndFillFields,
  fillResultMessage,
} from './fill-fields-from-screenshot';
export type { FillResult } from './fill-fields-from-screenshot';
export {
  pickAndUseScreenshot,
  useScreenshotResultMessage,
  buildImageOnlySignature,
} from './use-screenshot';
export type { UseScreenshotResult } from './use-screenshot';
export { sanitizeSignatureHtml } from './sanitize';
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mail-signature/index.ts
git commit -m "feat(mail-signature): export new screenshot import paths"
```

---

## Task 5: Wire up the three buttons in `MailSignatureSection`

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

The existing section currently has:
- one big "📷 Importér fra screenshot" button at the top, calling `onImportFromScreenshot`
- the manual form OR the imported preview, gated on `data.kind`

We change it to:
- big "📷 Reproducér fra screenshot" (renamed)
- smaller "Brug screenshot som billede" beneath
- inside the manual form (top of the field stack): compact "📷 Udfyld felter fra screenshot"
- a single shared `importError` state for all three (they're never simultaneous)
- `importing` state replaced by three booleans: `reproducing`, `usingImage`, `fillingFields`

- [ ] **Step 1: Update the imports at the top of `SettingsScreen.tsx`**

Find the existing block (around lines 69–85):

```typescript
import {
  loadSignature,
  saveSignature,
  subscribeSignature,
  pickAndCompressLogo,
  pickResultMessage,
  pickAndImportSignature,
  importResultMessage,
  renderSignature,
  EMPTY_SIGNATURE,
  type SignatureData,
  type StructuredSignature,
  type SocialLink,
  type SocialType,
  type LinkTarget,
  type InlineImage,
} from '../lib/mail-signature';
```

Replace with:

```typescript
import {
  loadSignature,
  saveSignature,
  subscribeSignature,
  pickAndCompressLogo,
  pickResultMessage,
  pickAndImportSignature,
  importResultMessage,
  pickAndFillFields,
  fillResultMessage,
  pickAndUseScreenshot,
  useScreenshotResultMessage,
  renderSignature,
  EMPTY_SIGNATURE,
  type SignatureData,
  type StructuredSignature,
  type SocialLink,
  type SocialType,
  type LinkTarget,
  type InlineImage,
} from '../lib/mail-signature';
```

- [ ] **Step 2: Replace the state declarations at the top of `MailSignatureSection`**

Find (around line 873):

```typescript
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
```

Replace with:

```typescript
  const [reproducing, setReproducing] = useState(false);
  const [usingImage, setUsingImage] = useState(false);
  const [fillingFields, setFillingFields] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const anyImporting = reproducing || usingImage || fillingFields;
```

- [ ] **Step 3: Rename `onImportFromScreenshot` to `onReproduceFromScreenshot` and update its busy flag**

Find (around line 929–944):

```typescript
  const onImportFromScreenshot = async () => {
    setImportError(null);
    setImporting(true);
    try {
      const result = await pickAndImportSignature();
      if (!result.ok) {
        const msg = importResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      setData(result.data);
      void saveSignature(result.data);
    } finally {
      setImporting(false);
    }
  };
```

Replace with:

```typescript
  const onReproduceFromScreenshot = async () => {
    setImportError(null);
    setReproducing(true);
    try {
      const result = await pickAndImportSignature();
      if (!result.ok) {
        const msg = importResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      setData(result.data);
      void saveSignature(result.data);
    } finally {
      setReproducing(false);
    }
  };

  const onUseScreenshotDirectly = async () => {
    setImportError(null);
    setUsingImage(true);
    try {
      const result = await pickAndUseScreenshot();
      if (!result.ok) {
        const msg = useScreenshotResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      setData(result.data);
      void saveSignature(result.data);
    } finally {
      setUsingImage(false);
    }
  };

  const onFillFieldsFromScreenshot = async () => {
    setImportError(null);
    setFillingFields(true);
    try {
      const result = await pickAndFillFields();
      if (!result.ok) {
        const msg = fillResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      // Preserve the existing logo (vision call doesn't touch it). Every
      // other field is replaced — partial merges create surprising mixed
      // states; the user explicitly asked to autofill from this screenshot.
      const existingLogo = data.kind === 'structured' ? data.logo : null;
      const next: StructuredSignature = { ...result.data, logo: existingLogo };
      setData(next);
      void saveSignature(next);
    } finally {
      setFillingFields(false);
    }
  };
```

- [ ] **Step 4: Update the JSX — top buttons**

Find (around line 1027–1040):

```typescript
      <Pressable
        onPress={onImportFromScreenshot}
        disabled={importing}
        style={[styles.sigImportBtn, importing && { opacity: 0.5 }]}
        accessibilityRole="button"
      >
        <Text style={styles.sigImportBtnTitle}>
          {importing ? 'Læser signatur…' : '📷 Importér fra screenshot'}
        </Text>
        <Text style={styles.sigImportBtnSub}>
          Lad Zolva udfylde felterne fra et billede af din nuværende signatur.
        </Text>
      </Pressable>
      {importError && <Text style={styles.sigError}>{importError}</Text>}
```

Replace with:

```typescript
      <Pressable
        onPress={onReproduceFromScreenshot}
        disabled={anyImporting}
        style={[styles.sigImportBtn, reproducing && { opacity: 0.5 }]}
        accessibilityRole="button"
      >
        <Text style={styles.sigImportBtnTitle}>
          {reproducing ? 'Reproducerer signatur…' : '📷 Reproducér fra screenshot'}
        </Text>
        <Text style={styles.sigImportBtnSub}>
          Zolva genskaber designet 1:1 ud fra et billede.
        </Text>
      </Pressable>

      <Pressable
        onPress={onUseScreenshotDirectly}
        disabled={anyImporting}
        style={[styles.sigUseImageBtn, usingImage && { opacity: 0.5 }]}
        accessibilityRole="button"
      >
        <Text style={styles.sigUseImageBtnText}>
          {usingImage ? 'Indlæser billede…' : 'Brug screenshot som billede'}
        </Text>
      </Pressable>

      {importError && <Text style={styles.sigError}>{importError}</Text>}
```

- [ ] **Step 5: Update the JSX — add the fill-fields button inside the structured branch**

Find (around line 1042–1054 — the start of the `data.kind === 'structured'` branch):

```typescript
      {data.kind === 'structured' ? (
        <>
          <SigField label="Navn"        value={data.name}        onChange={(v) => update({ name: v })}        onBlur={commit} editable={hydrated} />
```

Replace with:

```typescript
      {data.kind === 'structured' ? (
        <>
          <Pressable
            onPress={onFillFieldsFromScreenshot}
            disabled={anyImporting}
            style={[styles.sigFillFieldsBtn, fillingFields && { opacity: 0.5 }]}
            accessibilityRole="button"
          >
            <Text style={styles.sigFillFieldsBtnText}>
              {fillingFields ? 'Læser felter…' : '📷 Udfyld felter fra screenshot'}
            </Text>
          </Pressable>

          <SigField label="Navn"        value={data.name}        onChange={(v) => update({ name: v })}        onBlur={commit} editable={hydrated} />
```

- [ ] **Step 6: Add the new styles**

Find the existing `sigImportBtnSub` block (around line 2395):

```typescript
  sigImportBtnSub: {
    marginTop: 4,
    fontSize: 12,
    color: colors.fg3,
  },
```

Insert right after it:

```typescript
  sigUseImageBtn: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    alignItems: 'center',
  },
  sigUseImageBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.ink,
  },
  sigFillFieldsBtn: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.mist,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    alignItems: 'center',
  },
  sigFillFieldsBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
```

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 8: Run all signature tests**

Run: `npx jest src/lib/mail-signature/`

Expected: all green (no behavior in the tested modules changed; this is a sanity check).

- [ ] **Step 9: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(mail-signature): three screenshot entry points in settings UI"
```

---

## Task 6: Manual verification on a dev build

**Files:** none — this is a manual QA pass.

The unit tests cover the parsing/error paths. The full vision-call + image-picker flow needs hands-on verification.

- [ ] **Step 1: Start the dev build**

Run: `npx expo start --clear`

Open the app on a connected device (Expo Go is OK if your `.env` is in this worktree — see `feedback_worktree_dotenv` memory).

- [ ] **Step 2: Test path 1 — Reproducér from screenshot**

  - Navigate to Settings → Mail-signatur
  - Tap "📷 Reproducér fra screenshot"
  - Pick a known signature image from Photos
  - Expected: section flips to imported preview (WebView), socials row appears below
  - Cancel the picker once: expected to dismiss with no error and no state change

- [ ] **Step 3: Test path 2 — Brug screenshot som billede**

  - From the manual (structured) view, tap "Brug screenshot som billede"
  - Pick any image from Photos
  - Expected: preview shows the picked image, no AI delay, no socials extracted (socials row empty)
  - Verify the image is responsively sized (max-width:600px) — preview shouldn't overflow

- [ ] **Step 4: Test path 3 — Udfyld felter fra screenshot**

  - Tap "Skift til manuel redigering" if currently in imported mode
  - Tap "📷 Udfyld felter fra screenshot"
  - Pick a known signature image
  - Expected: form fields populate (name/title/company/phone/email/website + customLines + socials)
  - Mode stays `'structured'` (no flip to webview preview)
  - Existing logo (if any) is preserved
  - Editing any field afterwards works as before

- [ ] **Step 5: Test send paths**

  - Compose a test email through the app for each of the three modes (one each)
  - Send to your own inbox
  - Verify the signature renders correctly:
    - Reproducér: HTML reproduction looks like the screenshot
    - Image-only: shows the screenshot inline
    - Filled fields: structured signature renders normally

- [ ] **Step 6: If everything works, push the branch and we're done**

```bash
git push -u origin feature/mail-signature-screenshot
```

(Don't merge — solo project but Albert merges feature branches to main manually before OTA / build, per the `project_build_from_main` memory.)

---

## Spec coverage check

- [x] Path 1 (fill fields, stay manual) — Tasks 1, 2, 5
- [x] Path 2 (Reproducér, unchanged) — Task 5 only renames the handler/button
- [x] Path 3 (image-only, no AI) — Tasks 3, 5
- [x] New module `fill-fields-from-screenshot.ts` — Tasks 1, 2
- [x] No-AI helper `pickAndUseScreenshot` — Task 3
- [x] No data-model changes — confirmed (we reuse `kind: 'imported'`)
- [x] Logo preserved across fill-fields — Task 5 step 3
- [x] Out-of-scope items (UI distinction AI vs image, mid-flow chooser, smart merge, image edit UI) — left unimplemented as per spec
