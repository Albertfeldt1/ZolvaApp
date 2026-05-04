// src/lib/mail-signature/template.ts
//
// Pure HTML rendering for the rich mail signature. No I/O, no React,
// no provider knowledge — just SignatureData → HTML/plaintext.
//
// Layout uses a <table> wrapper because Outlook desktop on Windows uses
// Word's HTML rendering engine, which mishandles flexbox/grid. Inline
// styles only — Gmail strips <style> blocks.

import type { ImportedSignature, RenderedSignature, StructuredSignature, SocialLink, SocialType } from './types';

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// For customLines inside the signature: escape, then \n → <br>. No <p>
// wrap (would nest paragraphs inside the <br>-joined line list).
export function escapeWithBrBreaks(s: string): string {
  return escapeHtml(s).replaceAll('\n', '<br>');
}

// Markdown-style inline link: [text](url). Greedy on text, lazy on url so
// trailing punctuation outside the parens isn't gobbled. Captures (text, url).
const INLINE_LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

// For customLines: parse [text](url) into <a> hyperlinks, escape everything
// else, and convert \n to <br>. Unsafe URL schemes (anything that isn't
// http/https/mailto/tel after normalization) render as plain escaped text.
export function escapeWithLinksAndBrs(s: string): string {
  let out = '';
  let cursor = 0;
  for (const m of s.matchAll(INLINE_LINK_RE)) {
    const matchStart = m.index ?? 0;
    if (matchStart > cursor) {
      out += escapeHtml(s.slice(cursor, matchStart)).replaceAll('\n', '<br>');
    }
    const text = m[1];
    const rawUrl = m[2];
    const normalized = normalizeHrefForBody(rawUrl);
    if (normalized) {
      out += `<a href="${escapeHtml(normalized)}">${escapeHtml(text)}</a>`;
    } else {
      // Unsafe scheme — write the raw markdown back as escaped text so
      // nothing is silently dropped.
      out += escapeHtml(m[0]).replaceAll('\n', '<br>');
    }
    cursor = matchStart + m[0].length;
  }
  if (cursor < s.length) {
    out += escapeHtml(s.slice(cursor)).replaceAll('\n', '<br>');
  }
  return out;
}

// Body-context href normalizer. Returns '' for unsafe schemes so the
// caller knows to render the markdown source as plain text instead.
function normalizeHrefForBody(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return ''; // explicit unsafe scheme like javascript:
  return `https://${trimmed}`;
}

// Plaintext fallback for inline links: "text (url)" — readable in
// non-HTML mail clients without leaving raw markdown brackets in the
// alt body.
function plainTextInlineLinks(s: string): string {
  return s.replaceAll(INLINE_LINK_RE, (_match, text, url) => `${text} (${url})`);
}

// For the user's email body: escape, split on blank lines into paragraphs,
// remaining \n become <br>, wrap each paragraph in <p>...</p>.
export function bodyToParagraphs(s: string): string {
  const escaped = escapeHtml(s);
  const paragraphs = escaped.split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${p.replaceAll('\n', '<br>')}</p>`).join('');
}

function renderPlaintext(data: StructuredSignature): string {
  const lines: string[] = [];
  const headerParts: string[] = [];
  if (data.name) headerParts.push(data.name);
  if (data.title) headerParts.push(data.title);
  if (headerParts.length) lines.push(headerParts.join(' · '));
  if (data.company) lines.push(data.company);
  const contactParts: string[] = [];
  if (data.phone) contactParts.push(`T: ${data.phone}`);
  if (data.email) contactParts.push(data.email);
  if (contactParts.length) lines.push(contactParts.join(' · '));
  if (data.website) lines.push(data.website);
  if (data.customLines.trim()) lines.push(plainTextInlineLinks(data.customLines));
  return lines.join('\n');
}

export function renderSignature(data: StructuredSignature): RenderedSignature | null {
  const lines: string[] = [];
  const headerParts: string[] = [];

  if (data.name) headerParts.push(`<strong>${escapeHtml(data.name)}</strong>`);
  if (data.title) headerParts.push(escapeHtml(data.title));
  if (headerParts.length) lines.push(headerParts.join(' · '));

  if (data.company) lines.push(escapeHtml(data.company));

  const contactParts: string[] = [];
  if (data.phone) contactParts.push(`T: ${escapeHtml(data.phone)}`);
  if (data.email) {
    contactParts.push(`<a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a>`);
  }
  if (contactParts.length) lines.push(contactParts.join(' · '));

  if (data.website) {
    const href = data.website.startsWith('http') ? data.website : `https://${data.website}`;
    lines.push(`<a href="${escapeHtml(href)}">${escapeHtml(data.website)}</a>`);
  }

  if (data.customLines.trim()) {
    lines.push(escapeWithLinksAndBrs(data.customLines));
  }

  if (lines.length === 0 && !data.logo) return null;

  const textBlock = lines.length
    ? `<div style="font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">${lines.join('<br>')}</div>`
    : '';
  const imgBlock = data.logo
    ? `<div style="margin-top:8px"><img src="cid:zolva-sig" alt="" width="${data.logo.width}" height="${data.logo.height}" style="display:block;border:0"></div>`
    : '';
  const html = `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr><td>${imgBlock}${textBlock}</td></tr></table>`;

  return {
    html,
    plaintext: renderPlaintext(data),
    image: data.logo
      ? { contentId: 'zolva-sig', bytes: data.logo.base64, mimeType: data.logo.mimeType }
      : null,
  };
}

export function renderImported(sig: ImportedSignature): RenderedSignature | null {
  if (!sig.html.trim() && !sig.image) return null;
  return {
    html: sig.html,
    plaintext: sig.plaintext,
    image: sig.image
      ? { contentId: 'zolva-sig', bytes: sig.image.base64, mimeType: sig.image.mimeType }
      : null,
  };
}

const SOCIAL_LABELS: Record<SocialType, string> = {
  linkedin:  'LinkedIn',
  twitter:   'Twitter',
  instagram: 'Instagram',
  facebook:  'Facebook',
  tiktok:    'TikTok',
  youtube:   'YouTube',
  github:    'GitHub',
  website:   '',  // falls back to URL host
  other:     '',  // falls back to label || URL host
};

const SOCIAL_COLORS: Record<SocialType, string> = {
  linkedin:  '#0a66c2',
  twitter:   '#1da1f2',
  instagram: '#e4405f',
  facebook:  '#1877f2',
  tiktok:    '#1a1a1a',
  youtube:   '#ff0000',
  github:    '#1a1a1a',
  website:   '#1a1a1a',
  other:     '#1a1a1a',
};

function urlHost(url: string): string {
  // Light parse — sufficient for label fallback. Doesn't need to be perfect.
  const m = url.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : url;
}

// Prepend https:// to URLs that omit a scheme so the resulting <a href>
// is absolute. mailto: and tel: are pass-through. Empty/whitespace input
// returns '' so the caller can drop the link entirely.
function normalizeHref(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function socialDisplayName(link: SocialLink): string {
  if (link.type === 'website') {
    return link.label && link.label.trim() ? link.label : urlHost(link.url);
  }
  if (link.type === 'other') {
    return link.label && link.label.trim() ? link.label : urlHost(link.url);
  }
  return SOCIAL_LABELS[link.type];
}

export function renderSocials(socials: SocialLink[]): string {
  const items = socials.filter((s) => s.url.trim() !== '');
  if (items.length === 0) return '';

  const linkHtml = items
    .map((s) => {
      const color = SOCIAL_COLORS[s.type];
      const name = escapeHtml(socialDisplayName(s));
      const href = escapeHtml(normalizeHref(s.url));
      return `<a href="${href}" style="color:${color};text-decoration:none">${name}</a>`;
    })
    .join('<span style="color:#888"> · </span>');

  return `<div style="font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;margin-top:6px">${linkHtml}</div>`;
}
