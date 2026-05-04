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
- IMPORTANT — Social icons NEVER appear in the html output. The app renders them as proper brand-icon pills in a separate row below the html. The html must not contain ANY of:
  · <a> tags wrapping social-media icons
  · standalone single-letter, single-character, or single-emoji elements meant to represent a social platform — no "f", "X", "in", "Ig", "▶", "📸", "🐦", "🐙", "📺", or any other letter/emoji used as an icon stand-in
  · placeholder shapes (blue ovals, colored circles/squares, monogrammed pills) styled to LOOK like brand icons
  · rows of small icon-shaped elements with no real text content
  · any decorative reproduction of icon-only elements that don't have visible text
  Skip those elements entirely from the html. Pretend they aren't in the screenshot. Their information lives in the socials array, not the html.
- If no social-media or link icons are visible, return socials: [].

Inline icon markers (the small ones next to phone/email/website/address lines):
- These ARE part of the signature's design — reproduce them as small filled colored circles using inline styling: <span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:#XXXXXX;vertical-align:middle;text-align:center;color:#fff;font:10px Arial">X</span> or a one-cell <table> with a colored bgcolor.
- Inside the circle, use a SIMPLE TEXT GLYPH — a bold letter (T for telephone, @ for email, W for web, P or • for address) OR a Unicode geometric character (●, ◉, ☎, ✉ if you must). DO NOT use emoji (📞, ✉, 🌐, 📍, 📧, 🔗) — they render as full-color cartoon emoji which looks unprofessional in a corporate signature.
- Keep them on the SAME line as the phone number / email / URL / address that follows.

Divider lines and underline accents (REQUIRED if visible in source):
- If you see a horizontal line under the name, between sections, or at the bottom of the signature, emit it. Use <hr style="border:none;border-top:1px solid #cccccc;margin:8px 0"> for full-width dividers, or <div style="border-bottom:2px solid #1c2e3a;width:80px;padding-bottom:4px"></div> for shorter accent underlines under a name/title.
- Do not skip dividers or underline accents. They're visually load-bearing — without them the signature reads as flat content rather than the structured layout you saw.

Decorative elements:
- Do not reproduce decorative shapes that aren't real visual elements (no blank colored rectangles or empty styled boxes that don't represent anything). Real layout elements — dividers, lines, contact icons, brand backgrounds — are good to keep.
- Do not invent emoji anywhere in the html. Use plain text and CSS-styled shapes only. Emoji look out of place in a corporate signature reproduction.

Return your output via the import_signature tool with three fields:
- html: the Outlook-safe HTML (typically wrapped in a <table>)
- plaintext: a plain-text version of the signature for multipart/alt
- logoBox: if a company logo or person photo is visible, an object { x, y, w, h } in pixel coordinates of the image you were shown (where (0,0) is the top-left).
  · Be VERY GENEROUS with the bounding box — include a comfortable margin around the logo on every side so the edges aren't clipped.
  · If a logo SYMBOL appears with a company NAME / wordmark / tagline next to it (left, right, above, or below) as a unit, BOX BOTH TOGETHER — the box must include the full wordmark text, not just the iconography. A logo "Logox" with an octagon glyph + "Logox" text + tagline is one bounding box covering all three.
  · If multiple icons or images are visible, choose the most prominent / largest one (typically the main company logo or person photo, NOT small social-media icons or tiny inline contact-line markers).
  · If no logo or photo is visible, null.

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

async function cropLogo(
  resizedUri: string,
  imgW: number,
  imgH: number,
  box: { x: number; y: number; w: number; h: number },
): Promise<InlineImage | null> {
  // Vision models are imprecise at exact pixel coordinates AND tend to
  // box just the iconography while a wordmark sits right next to it.
  // Pad horizontally by 35% (min 16 px) to capture adjacent wordmarks,
  // and 18% vertically (min 10 px) for clean top/bottom edges. Clamps
  // to image bounds so the crop never overruns. Generous padding picks
  // up some whitespace from the screenshot — fine since signatures
  // typically live on a paper-colored background.
  const padX = Math.max(16, Math.round(box.w * 0.35));
  const padY = Math.max(10, Math.round(box.h * 0.18));
  const x = Math.max(0, Math.round(box.x - padX));
  const y = Math.max(0, Math.round(box.y - padY));
  const w = Math.min(imgW - x, Math.round(box.w + 2 * padX));
  const h = Math.min(imgH - y, Math.round(box.h + 2 * padY));

  // Sanity: reject pathological boxes (zero/negative dims, tiny noise,
  // or a box that swallows most of the screenshot — almost always a
  // hallucination).
  if (w < 16 || h < 16) return null;
  if (w * h > 0.7 * imgW * imgH) return null;

  try {
    const cropped = await manipulateAsync(
      resizedUri,
      [{ crop: { originX: x, originY: y, width: w, height: h } }],
      { format: SaveFormat.PNG, base64: true },
    );
    if (!cropped.base64) return null;
    return {
      base64: cropped.base64,
      mimeType: 'image/png',
      width: w,
      height: h,
    };
  } catch {
    return null;
  }
}

// Strip empty styled containers — decorative shapes, post-sanitize SVG
// remnants, and the empty wrapper bars left behind when social-icon
// children get sanitized out. Keeps contact-line icons (small filled
// circles with a glyph inside) since their length-1-2 content survives
// the empty-only rule.
//
// Iterates until stable: stripping inner empty elements may leave the
// outer wrapper empty in turn (e.g. <table><tr><td bg></td></tr></table>
// → <table><tr></tr></table> → empty table). Each pass walks more
// element types (tr/table) than the per-pass regex would normally cover.
export function stripIconStandIns(html: string): string {
  let prev = html;
  let curr = stripEmptyStyledOnce(html);
  // Bound iteration to a few passes; pathological inputs shouldn't loop.
  let safety = 6;
  while (curr !== prev && safety-- > 0) {
    prev = curr;
    curr = stripEmptyStyledOnce(curr);
  }
  return curr;
}

function stripEmptyStyledOnce(html: string): string {
  // table and tr included: empty table/row containers left behind after
  // their inner styled cells are stripped should also go.
  const re = /<(a|td|tr|table|div|span)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  return html.replace(re, (match, tag: string, attrs: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length !== 0) return match;
    if (/<img\b/i.test(inner)) return match;
    // For <tr>/<table>, drop if empty even without a colored background —
    // they have no semantic value once their cells are gone.
    if (tag.toLowerCase() === 'tr' || tag.toLowerCase() === 'table') {
      return '';
    }
    if (!hasColoredBackground(attrs)) return match;
    return '';
  });
}

function hasColoredBackground(attrs: string): boolean {
  const styleMatch = attrs.match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  const styleVal = styleMatch ? (styleMatch[1] ?? styleMatch[2] ?? styleMatch[3] ?? '') : '';
  if (styleVal) {
    const bgMatch = styleVal.match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (bgMatch) {
      const v = bgMatch[1].trim();
      if (v && !/^(transparent|none|inherit|initial|unset)$/i.test(v)
            && !/^(#fff(fff)?|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/i.test(v)) {
        return true;
      }
    }
  }
  const bgcolorMatch = attrs.match(/\bbgcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  const bgcolorVal = bgcolorMatch ? (bgcolorMatch[1] ?? bgcolorMatch[2] ?? bgcolorMatch[3] ?? '') : '';
  if (bgcolorVal && !/^(transparent|#fff(fff)?|white)$/i.test(bgcolorVal)) {
    return true;
  }
  return false;
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
      model: 'claude-sonnet-4-6',
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
  const cleaned = stripIconStandIns(sanitized);
  if (!cleaned) {
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
    html: cleaned,
    plaintext: parsed.value.plaintext,
    image,
    importedAt: Date.now(),
    socials: parsed.value.socials,
  };
  return { ok: true, data };
}
