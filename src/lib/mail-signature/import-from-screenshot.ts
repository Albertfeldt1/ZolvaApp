// src/lib/mail-signature/import-from-screenshot.ts
//
// Vision-based signature import (HTML reproduction).
//
// Pipeline:
//   1. Pick image via expo-image-picker.
//   2. Resize to 1024px long side, JPEG q=0.85, base64.
//   3. Vision call via completeWithTool — Claude tool-use returns
//      { html, plaintext, logoBox }.
//   4. Sanitize html via sanitizeSignatureHtml.
//   5. Crop logo from the resized image at logoBox (sanity-checked).
//   6. Build ImportedSignature and return.
//
// Pure parts (parseImportToolUse, mapClaudeError, importResultMessage)
// are unit-tested. The orchestrator depends on Expo runtime + the live
// Claude call and is verified manually.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { ClaudeRateLimitError, ClaudeConfigError, completeWithTool } from '../claude';
import { sanitizeSignatureHtml } from './sanitize';
import type { ImportedSignature, InlineImage, SocialLink, SocialType } from './types';

const VISION_MAX_DIMENSION = 1024;

const SOCIAL_TYPES: ReadonlyArray<SocialType> = [
  'linkedin', 'twitter', 'instagram', 'facebook',
  'tiktok', 'youtube', 'github', 'website', 'other',
];
const VISION_MAX_BASE64_LEN = 300_000;

const SIGNATURE_IMPORT_SYSTEM_PROMPT = `You reproduce the visual design of an email signature from a screenshot, as Outlook-safe HTML.

CRITICAL constraints — output that violates these will be sanitized away:
- Layout: use <table> elements only. No flexbox, grid, or modern positioning.
- Styling: inline style="..." attributes only. No <style>, <script>, <link>, <iframe>, no @import, no @font-face.
- Fonts: system stack only — e.g. font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif. No web fonts.
- Properties allowed: font-family, font-size, font-weight, font-style, color, background-color, text-align, text-decoration, padding, margin, border, line-height, vertical-align, white-space. Do not use position, transform, animation, opacity.
- URLs: <a href="..."> may use mailto:, tel:, https://, http://. <img> may ONLY be src="cid:zolva-sig" (we'll inject the cropped logo). No data: URIs, no remote URLs.

Reproduce the screenshot's visible content as faithfully as possible: text content, weights, italics, colors, alignment, dividers, and the visual structure (single line vs multi-line vs columns implemented as nested tables).

Social-media icons and link icons:
- If the screenshot contains social-media link icons (LinkedIn, Twitter/X, Instagram, Facebook, TikTok, YouTube, GitHub) or generic website/link icons (globe, "www", a personal/company URL displayed as a clickable element), extract them as a "socials" array. Each entry has a "type" (one of: linkedin, twitter, instagram, facebook, tiktok, youtube, github, website, other) and a "url". Use "website" for generic homepage/portfolio/company URLs that aren't a known platform. Use "other" with a "label" field for non-website platforms not in this list (e.g. Bluesky, Mastodon, Threads).
- IMPORTANT: Do NOT include these icon links in the html output. We render the social row separately. The html must not contain ANY of:
  · <a> tags wrapping social-media icons
  · placeholder shapes/letters meant to look like brand icons (no blue ovals, colored squares, single-letter monograms, etc.)
  · any decorative reproduction of icon-only elements that don't have visible text
  Skip those elements entirely. Pretend they aren't in the screenshot.
- If no social-media or link icons are visible, return socials: [].

Decorative elements:
- Do not reproduce decorative shapes that aren't real text content (e.g. blank colored rectangles, circles, or geometric ornaments). Only reproduce text and bona-fide structural elements (lines, dividers, layout columns).

Return your output via the import_signature tool with three fields:
- html: the Outlook-safe HTML (typically wrapped in a <table>)
- plaintext: a plain-text version of the signature for multipart/alt
- logoBox: if a logo or photo is visible, an object { x, y, w, h } in pixel coordinates of the screenshot you were shown. If no logo/photo is visible, null.

If the screenshot doesn't appear to contain an email signature (e.g. it's a generic email body or unrelated content), return html: "", plaintext: "" and logoBox: null.`;

const IMPORT_TOOL = {
  name: 'import_signature',
  description: 'Output the reproduced signature HTML, plaintext fallback, optional logo bounding box, and any social-media link icons.',
  input_schema: {
    type: 'object',
    properties: {
      html: { type: 'string' },
      plaintext: { type: 'string' },
      logoBox: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
        ],
      },
      socials: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: SOCIAL_TYPES as unknown as string[] },
            url: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['type', 'url'],
        },
      },
    },
    required: ['html', 'plaintext', 'logoBox'],
  },
};

export type ImportResult =
  | { ok: true; data: ImportedSignature }
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

type ToolUseResult = {
  html: string;
  plaintext: string;
  logoBox: { x: number; y: number; w: number; h: number } | null;
  socials: SocialLink[];
};

type ParseOk = { ok: true; value: ToolUseResult };
type ParseFail = { ok: false };

export function parseImportToolUse(input: unknown): ParseOk | ParseFail {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.html !== 'string' || typeof obj.plaintext !== 'string') {
    return { ok: false };
  }
  let logoBox: ToolUseResult['logoBox'] = null;
  if (obj.logoBox !== null && obj.logoBox !== undefined) {
    if (typeof obj.logoBox !== 'object' || Array.isArray(obj.logoBox)) return { ok: false };
    const lb = obj.logoBox as Record<string, unknown>;
    if (
      typeof lb.x !== 'number' ||
      typeof lb.y !== 'number' ||
      typeof lb.w !== 'number' ||
      typeof lb.h !== 'number'
    ) {
      return { ok: false };
    }
    logoBox = { x: lb.x, y: lb.y, w: lb.w, h: lb.h };
  }
  let socials: SocialLink[] = [];
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
      socials.push(link);
    }
  }
  return { ok: true, value: { html: obj.html, plaintext: obj.plaintext, logoBox, socials } };
}

export function mapClaudeError(err: unknown): ImportResult {
  if (err instanceof ClaudeRateLimitError) return { ok: false, reason: 'rate-limit' };
  if (err instanceof ClaudeConfigError) return { ok: false, reason: 'unauthorized' };
  if (err instanceof TypeError && /network/i.test(err.message)) {
    return { ok: false, reason: 'network' };
  }
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

function isImplausibleBox(box: { x: number; y: number; w: number; h: number }, imgW: number, imgH: number): boolean {
  if (box.w <= 0 || box.h <= 0) return true;
  if (box.x < 0 || box.y < 0) return true;
  if (box.x + box.w > imgW || box.y + box.h > imgH) return true;
  if (box.w * box.h > 0.5 * imgW * imgH) return true;
  return false;
}

async function cropLogo(
  resizedUri: string,
  imgW: number,
  imgH: number,
  box: { x: number; y: number; w: number; h: number },
): Promise<InlineImage | null> {
  if (isImplausibleBox(box, imgW, imgH)) return null;
  try {
    const cropped = await manipulateAsync(
      resizedUri,
      [{ crop: { originX: box.x, originY: box.y, width: box.w, height: box.h } }],
      { format: SaveFormat.PNG, base64: true },
    );
    if (!cropped.base64) return null;
    return {
      base64: cropped.base64,
      mimeType: 'image/png',
      width: Math.round(box.w),
      height: Math.round(box.h),
    };
  } catch {
    return null;
  }
}

export async function pickAndImportSignature(): Promise<ImportResult> {
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
  let resizedWidth = 0;
  let resizedHeight = 0;
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
    resizedWidth = manipulated.width ?? targetWidth;
    resizedHeight = manipulated.height ?? targetHeight;
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
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 2000,
      system: SIGNATURE_IMPORT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: 'Reproduce this signature using the import_signature tool.' },
          ],
        },
      ],
      tool: IMPORT_TOOL,
      attachProfile: false,
    });
  } catch (err) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return mapClaudeError(err);
  }

  const parsed = parseImportToolUse(toolInput);
  if (!parsed.ok) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return { ok: false, reason: 'parse-failed' };
  }

  const sanitized = sanitizeSignatureHtml(parsed.value.html);
  if (!sanitized) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return { ok: false, reason: 'no-data' };
  }

  let image: InlineImage | null = null;
  if (parsed.value.logoBox) {
    image = await cropLogo(resizedUri, resizedWidth, resizedHeight, parsed.value.logoBox);
  }

  try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}

  const data: ImportedSignature = {
    kind: 'imported',
    html: sanitized,
    plaintext: parsed.value.plaintext,
    image,
    importedAt: Date.now(),
    socials: parsed.value.socials,
  };
  return { ok: true, data };
}
