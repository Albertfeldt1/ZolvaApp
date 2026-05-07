// src/lib/mail-signature/sanitize.ts
//
// Pure HTML/CSS allowlist filter for screenshot-imported signatures.
// Hand-rolled tokenizer (no DOM dependency - DOMPurify wants window).
// Output is guaranteed to be a strict Outlook-Word-rendering-engine-safe
// subset: <table> layout, inline styles, allowlisted attrs, allowlisted
// CSS properties, mailto/tel/https/http links, cid:zolva-sig images only.

const TAG_ALLOWLIST = new Set([
  'table', 'tr', 'td', 'tbody', 'thead', 'tfoot',
  'div', 'span', 'p', 'br', 'hr',
  'b', 'strong', 'i', 'em', 'u',
  'a', 'img',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'font',
]);

// Tags whose entire content (including text inside) gets dropped.
const STRIP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'noscript',
]);

const ATTR_ALLOWLIST: Record<string, Set<string>> = {
  table: new Set(['cellpadding', 'cellspacing', 'border', 'align', 'valign', 'bgcolor', 'width', 'height']),
  tr: new Set(['align', 'valign', 'bgcolor', 'width', 'height']),
  td: new Set(['align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan']),
  a: new Set(['href', 'target']),
  img: new Set(['src', 'alt', 'width', 'height']),
  font: new Set(['color', 'face', 'size']),
};

const HREF_SCHEME_RE = /^(mailto:|tel:|https?:\/\/)/i;
const IMG_SRC_OK = 'cid:zolva-sig';

const STYLE_PROP_ALLOWLIST_RE =
  /^(font-(family|size|weight|style|variant)|color|background-color|text-align|text-decoration|padding(-\w+)?|margin(-\w+)?|border(-\w+)?(-\w+)?|line-height|vertical-align|white-space|display)$/;

function isDangerousStyleValue(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('expression(') ||
    lower.includes('javascript:') ||
    lower.includes('@import') ||
    /url\s*\(\s*['"]?https?:/.test(lower) ||
    lower.includes('<') ||
    lower.includes('>')
  );
}

function filterStyleAttr(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const prop = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (!STYLE_PROP_ALLOWLIST_RE.test(prop)) continue;
    if (isDangerousStyleValue(value)) continue;
    if (prop === 'display') {
      const v = value.toLowerCase();
      if (v !== 'block' && v !== 'inline-block') continue;
    }
    out.push(`${prop}:${value}`);
  }
  return out.join(';');
}

type Token =
  | { kind: 'text'; raw: string }
  | { kind: 'open'; tag: string; attrs: string }
  | { kind: 'close'; tag: string }
  | { kind: 'self'; tag: string; attrs: string }
  | { kind: 'comment' }
  | { kind: 'doctype' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '<') {
      // Comment
      if (input.startsWith('<!--', i)) {
        const end = input.indexOf('-->', i + 4);
        i = end < 0 ? input.length : end + 3;
        tokens.push({ kind: 'comment' });
        continue;
      }
      // DOCTYPE / processing instruction / CDATA
      if (input[i + 1] === '!' || input[i + 1] === '?') {
        const end = input.indexOf('>', i);
        i = end < 0 ? input.length : end + 1;
        tokens.push({ kind: 'doctype' });
        continue;
      }
      // Closing tag
      if (input[i + 1] === '/') {
        const end = input.indexOf('>', i);
        if (end < 0) { i = input.length; continue; }
        const tag = input.slice(i + 2, end).trim().toLowerCase();
        i = end + 1;
        tokens.push({ kind: 'close', tag });
        continue;
      }
      // Open or self-closing tag
      const end = input.indexOf('>', i);
      if (end < 0) {
        tokens.push({ kind: 'text', raw: input.slice(i) });
        i = input.length;
        continue;
      }
      const inner = input.slice(i + 1, end).trim();
      const selfClose = inner.endsWith('/');
      const head = selfClose ? inner.slice(0, -1).trim() : inner;
      const spaceIdx = head.search(/\s/);
      const tag = (spaceIdx < 0 ? head : head.slice(0, spaceIdx)).toLowerCase();
      const attrs = spaceIdx < 0 ? '' : head.slice(spaceIdx + 1);
      i = end + 1;
      if (selfClose || tag === 'br' || tag === 'hr' || tag === 'img') {
        tokens.push({ kind: 'self', tag, attrs });
      } else {
        tokens.push({ kind: 'open', tag, attrs });
      }
      continue;
    }
    // Text run
    const next = input.indexOf('<', i);
    if (next < 0) {
      tokens.push({ kind: 'text', raw: input.slice(i) });
      i = input.length;
    } else {
      tokens.push({ kind: 'text', raw: input.slice(i, next) });
      i = next;
    }
  }
  return tokens;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const m of raw.matchAll(re)) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[name] = value;
  }
  return out;
}

function serializeAttrs(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === '') {
      parts.push(name);
    } else {
      parts.push(`${name}="${value.replaceAll('"', '&quot;')}"`);
    }
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function filterAttrs(tag: string, raw: string): Record<string, string> {
  const parsed = parseAttrs(raw);
  const allowed = ATTR_ALLOWLIST[tag] ?? new Set<string>();
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(parsed)) {
    if (name.startsWith('on')) continue;
    if (name === 'style') {
      const filtered = filterStyleAttr(value);
      if (filtered) out.style = filtered;
      continue;
    }
    if (!allowed.has(name)) continue;

    if (tag === 'a' && name === 'href') {
      if (HREF_SCHEME_RE.test(value)) out.href = value;
      continue;
    }
    if (tag === 'a' && name === 'target') {
      if (value === '_blank') out.target = value;
      continue;
    }
    if (tag === 'img' && name === 'src') {
      if (value === IMG_SRC_OK) out.src = value;
      continue;
    }

    out[name] = value;
  }
  return out;
}

export function sanitizeSignatureHtml(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  const tokens = tokenize(input);
  const out: string[] = [];
  let dropDepth = 0;
  let dropTag = '';

  for (const tok of tokens) {
    if (dropDepth > 0) {
      if (tok.kind === 'close' && tok.tag === dropTag) {
        dropDepth--;
        if (dropDepth === 0) dropTag = '';
      } else if (tok.kind === 'open' && tok.tag === dropTag) {
        dropDepth++;
      }
      continue;
    }

    if (tok.kind === 'comment' || tok.kind === 'doctype') continue;

    if (tok.kind === 'text') {
      out.push(tok.raw);
      continue;
    }

    if (tok.kind === 'open' || tok.kind === 'self') {
      if (STRIP_WITH_CONTENT.has(tok.tag)) {
        if (tok.kind === 'open') {
          dropDepth = 1;
          dropTag = tok.tag;
        }
        continue;
      }
      if (!TAG_ALLOWLIST.has(tok.tag)) continue;
      const attrs = filterAttrs(tok.tag, tok.attrs);
      // For img, if src didn't pass, drop the whole tag
      if (tok.tag === 'img' && !attrs.src) continue;
      const serialized = serializeAttrs(attrs);
      out.push(`<${tok.tag}${serialized}>`);
      continue;
    }

    if (tok.kind === 'close') {
      if (!TAG_ALLOWLIST.has(tok.tag)) continue;
      out.push(`</${tok.tag}>`);
      continue;
    }
  }

  return out.join('');
}
