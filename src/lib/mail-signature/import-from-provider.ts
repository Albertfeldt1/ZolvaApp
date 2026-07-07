// src/lib/mail-signature/import-from-provider.ts
//
// Provider-based signature import - pulls the user's existing signature
// from their mail provider so they don't have to retype it:
//
//   - Gmail: the official sendAs settings endpoint returns the signature
//     as raw HTML. Covered by the existing gmail.readonly scope.
//   - Outlook: Microsoft Graph exposes NO signature endpoint (signatures
//     live in the Outlook client). But mail composed in Outlook (web, new
//     desktop, mobile) wraps the signature in <div id="Signature"> - so we
//     scan the most recent sent mails and lift the block from the first hit.
//     Mails sent through Zolva itself carry no marker and are skipped.
//
// Both paths funnel through the same sanitize pipeline as the screenshot
// import and produce an ImportedSignature. At most one image survives:
// the first http(s) logo is downloaded and inlined as cid:zolva-sig,
// Outlook cid: logos are resolved via the message's attachments, and
// every other <img> is stripped by the sanitizer.

import { Image } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { ProviderAuthError } from '../auth';
import { fetchGmailSignatureHtml } from '../gmail';
import { getInlineImageAttachment, listSentMessageBodies } from '../microsoft-graph';
import { NetworkTimeoutError } from '../network-errors';
import { stripCidImageReferences, stripIconStandIns } from './import-from-screenshot';
import { sanitizeSignatureHtml } from './sanitize';
import type { ImportedSignature, InlineImage } from './types';

export type ProviderImportResult =
  | { ok: true; data: ImportedSignature }
  | { ok: false; reason: 'no-signature' | 'network' | 'unauthorized' | 'failed' };

const OUTLOOK_SENT_SCAN_COUNT = 10;
const MAX_LOGO_BASE64_LEN = 1_500_000; // ~1.1 MB decoded - signatures hold logos, not photos
const FALLBACK_LOGO_SIZE = { width: 120, height: 48 };

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────

// Locate Outlook's signature marker and return the balanced <div> block.
// Case-insensitive on the id value: OWA emits "Signature", some clients
// lowercase it.
const SIG_DIV_RE = /<div\b[^>]*\bid\s*=\s*["']?signature["']?[^>]*>/i;

export function extractOutlookSignatureHtml(bodyHtml: string): string | null {
  const m = SIG_DIV_RE.exec(bodyHtml);
  if (!m) return null;
  const start = m.index;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let depth = 0;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(bodyHtml))) {
    depth += tag[0][1] === '/' ? -1 : 1;
    if (depth === 0) {
      return bodyHtml.slice(start, tag.index + tag[0].length);
    }
  }
  return null; // unbalanced markup - bail rather than guess
}

type RewriteResult = {
  html: string;
  /** Original src of the rewritten <img>, null when no importable image. */
  src: string | null;
  width?: number;
  height?: number;
};

// Point the first http(s)/cid <img> at cid:zolva-sig (the only src the
// sanitizer lets through) and report its original src + declared size so
// the caller can fetch the bytes.
export function rewriteFirstImageToCid(html: string): RewriteResult {
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    const srcM = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    if (!srcM) continue;
    const src = srcM[1] ?? srcM[2] ?? srcM[3] ?? '';
    if (!/^(https?:\/\/|cid:)/i.test(src)) continue;
    const newTag = tag.replace(srcM[0], 'src="cid:zolva-sig"');
    return {
      html: html.slice(0, m.index) + newTag + html.slice(m.index + tag.length),
      src,
      width: attrNumber(tag, 'width'),
      height: attrNumber(tag, 'height'),
    };
  }
  return { html, src: null };
}

function attrNumber(tag: string, name: string): number | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'));
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Plaintext fallback for multipart/alt - derived from the sanitized html.
// Both opening and closing block tags break lines (with adjacent close+open
// collapsed to one break) - signatures are shaped like
// "Venlig hilsen.<div>Oscar</div>", where breaking only on the close would
// glue the salutation onto the name.
export function htmlToPlaintext(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|td|h[1-6]|li)>\s*<(?:p|div|tr|h[1-6]|li)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|tr|td|h[1-6]|li)>/gi, '\n')
    .replace(/<(?:p|div|tr|h[1-6]|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Shared tail of both provider paths: sanitize, drop empty wrappers left
// behind by stripped social icons, resolve the cid reference, derive the
// plaintext alt. Returns null when nothing usable survives.
export function finalizeImportedSignature(
  rawHtml: string,
  image: InlineImage | null,
  importedAt = Date.now(),
): ImportedSignature | null {
  const sanitized = sanitizeSignatureHtml(rawHtml);
  const cleaned = stripIconStandIns(sanitized);
  const html = image ? cleaned : stripCidImageReferences(cleaned);
  const plaintext = htmlToPlaintext(html);
  if (!plaintext && !image) return null;
  return { kind: 'imported', html, plaintext, image, importedAt, socials: [] };
}

// ─── Image resolution ────────────────────────────────────────────────────

function normalizeImageMime(raw: string | undefined | null): InlineImage['mimeType'] | null {
  const mime = (raw ?? '').toLowerCase().split(';')[0].trim();
  if (mime === 'image/png') return 'image/png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'image/jpeg';
  return null;
}

function measure(dataUri: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    Image.getSize(
      dataUri,
      (width, height) => resolve(width > 0 && height > 0 ? { width, height } : null),
      () => resolve(null),
    );
  });
}

async function toInlineImage(
  base64: string,
  mimeType: InlineImage['mimeType'],
  declared: { width?: number; height?: number },
): Promise<InlineImage | null> {
  if (!base64 || base64.length > MAX_LOGO_BASE64_LEN) return null;
  let width = declared.width;
  let height = declared.height;
  if (!width || !height) {
    const measured = await measure(`data:${mimeType};base64,${base64}`);
    width = measured?.width ?? FALLBACK_LOGO_SIZE.width;
    height = measured?.height ?? FALLBACK_LOGO_SIZE.height;
  }
  return { base64, mimeType, width, height };
}

async function downloadRemoteImage(
  url: string,
  declared: { width?: number; height?: number },
): Promise<InlineImage | null> {
  const target = `${FileSystem.cacheDirectory}sig-provider-import.img`;
  try {
    const dl = await FileSystem.downloadAsync(url, target);
    if (dl.status !== 200) return null;
    const mime = normalizeImageMime(dl.headers['Content-Type'] ?? dl.headers['content-type']);
    if (!mime) return null;
    const base64 = await FileSystem.readAsStringAsync(target, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return await toInlineImage(base64, mime, declared);
  } catch {
    return null; // the logo is nice-to-have - never sink the import over it
  } finally {
    try { await FileSystem.deleteAsync(target, { idempotent: true }); } catch {}
  }
}

// ─── Orchestrators ───────────────────────────────────────────────────────

function mapProviderError(err: unknown): Extract<ProviderImportResult, { ok: false }> {
  if (err instanceof ProviderAuthError) return { ok: false, reason: 'unauthorized' };
  if (err instanceof NetworkTimeoutError) return { ok: false, reason: 'network' };
  if (err instanceof TypeError && /network/i.test(err.message)) {
    return { ok: false, reason: 'network' };
  }
  return { ok: false, reason: 'failed' };
}

export async function importSignatureFromGmail(): Promise<ProviderImportResult> {
  let raw: string | null;
  try {
    raw = await fetchGmailSignatureHtml();
  } catch (err) {
    return mapProviderError(err);
  }
  if (!raw) return { ok: false, reason: 'no-signature' };

  const rewritten = rewriteFirstImageToCid(raw);
  let image: InlineImage | null = null;
  if (rewritten.src && /^https?:\/\//i.test(rewritten.src)) {
    image = await downloadRemoteImage(rewritten.src, rewritten);
  }
  const data = finalizeImportedSignature(rewritten.html, image);
  if (!data) return { ok: false, reason: 'no-signature' };
  return { ok: true, data };
}

export async function importSignatureFromOutlook(): Promise<ProviderImportResult> {
  let messages: Array<{ id: string; html: string }>;
  try {
    messages = await listSentMessageBodies(OUTLOOK_SENT_SCAN_COUNT);
  } catch (err) {
    return mapProviderError(err);
  }

  for (const msg of messages) {
    const sigBlock = extractOutlookSignatureHtml(msg.html);
    if (!sigBlock) continue;

    const rewritten = rewriteFirstImageToCid(sigBlock);
    let image: InlineImage | null = null;
    if (rewritten.src) {
      if (/^cid:/i.test(rewritten.src)) {
        try {
          const att = await getInlineImageAttachment(msg.id, rewritten.src.slice(4));
          const mime = normalizeImageMime(att?.contentType);
          if (att && mime) image = await toInlineImage(att.contentBytes, mime, rewritten);
        } catch {
          // logo resolution is best-effort
        }
      } else {
        image = await downloadRemoteImage(rewritten.src, rewritten);
      }
    }

    const data = finalizeImportedSignature(rewritten.html, image);
    if (data) return { ok: true, data };
  }
  return { ok: false, reason: 'no-signature' };
}

export function providerImportMessage(
  result: Extract<ProviderImportResult, { ok: false }>,
  provider: 'google' | 'microsoft',
): string {
  const name = provider === 'google' ? 'Gmail' : 'Outlook';
  switch (result.reason) {
    case 'no-signature':
      return provider === 'google'
        ? 'Der er ingen signatur sat op i din Gmail-konto.'
        : 'Vi fandt ingen signatur i dine seneste sendte mails. Prøv "Reproducér fra screenshot" i stedet.';
    case 'unauthorized':
      return `Forbind ${name} igen under Forbundet, og prøv så igen.`;
    case 'network':
      return 'Ingen forbindelse. Prøv igen.';
    case 'failed':
      return `Kunne ikke hente signaturen fra ${name}. Prøv igen.`;
  }
}
