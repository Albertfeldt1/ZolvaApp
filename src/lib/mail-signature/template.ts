// src/lib/mail-signature/template.ts
//
// Pure HTML rendering for the rich mail signature. No I/O, no React,
// no provider knowledge — just SignatureData → HTML/plaintext.
//
// Layout uses a <table> wrapper because Outlook desktop on Windows uses
// Word's HTML rendering engine, which mishandles flexbox/grid. Inline
// styles only — Gmail strips <style> blocks.

import type { ImportedSignature, RenderedSignature, StructuredSignature } from './types';

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
  if (data.customLines.trim()) lines.push(data.customLines);
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
    lines.push(escapeWithBrBreaks(data.customLines));
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
