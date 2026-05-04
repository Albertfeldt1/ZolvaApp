// src/lib/mail-signature/detect-targets.ts
//
// Extracts "bindable elements" from a sanitized signature HTML string.
// These become candidate entries for the user's "Bind til" picker.
//
// Uses a two-pass regex approach:
//   Pass 1 — walk <img> tags to extract src + alt.
//   Pass 2 — strip all tags (and their attribute text) to get plain text,
//             then tokenize into words.
//
// No DOM dependency — pure string operations only.

export type DetectedTargets = {
  /**
   * Bindable text fragments with at least 2 characters — words, multi-word
   * phrases ("Find me on Facebook"), text runs with punctuation
   * ("Let's connect!"). Sorted longer-first so phrases surface at the top
   * of the bind picker. Cap 50 entries.
   */
  words: string[];
  /**
   * Single-character tokens and emoji-like symbols Claude leaves behind
   * for icon stand-ins ("f", "X", "▶", "@"). Bindable — but rendered in
   * the picker's "BILLEDER" section because they're visually decorative,
   * not real text. Same target.kind as words ('word'), the picker just
   * categorizes them differently.
   */
  glyphs: string[];
  /**
   * Styled CTA buttons — <a> elements whose inline style includes a
   * background color (e.g. the "Find me on Facebook" / "Let's connect!"
   * boxes Claude reproduces). Each entry has the button's visible text
   * label and the background color so the picker can render a tiny
   * preview chip. Bindable as the same target.kind as a phrase.
   */
  buttons: { text: string; bgColor: string }[];
  /** Each unique <img src=...>; description is alt if present, else 'Billede'. */
  images: { src: string; description: string }[];
};

// Tags whose entire content (text + children) is skipped for word extraction.
const SKIP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'noscript']);

// Matches an <img ...> tag and captures the full attribute string.
const IMG_TAG_RE = /<img\b([^>]*)>/gi;

// Extracts a named attribute value from a raw attribute string.
function getAttr(attrs: string, name: string): string | undefined {
  // Match name="value", name='value', or name=value
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = attrs.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3] ?? undefined;
}

/**
 * Extracts bindable targets (words + images) from a sanitized signature HTML
 * string. Returns empty arrays for non-string or empty input.
 */
export function detectImportedTargets(html: unknown): DetectedTargets {
  if (typeof html !== 'string' || html.length === 0) {
    return { words: [], glyphs: [], buttons: [], images: [] };
  }

  // ── Pass 1: extract images ───────────────────────────────────────────────
  const images: { src: string; description: string }[] = [];
  const seenSrcs = new Set<string>();

  let imgMatch: RegExpExecArray | null;
  IMG_TAG_RE.lastIndex = 0;
  while ((imgMatch = IMG_TAG_RE.exec(html)) !== null) {
    const attrs = imgMatch[1];
    const src = getAttr(attrs, 'src');
    if (!src) continue;
    if (seenSrcs.has(src)) continue;
    seenSrcs.add(src);
    const alt = getAttr(attrs, 'alt');
    const description = alt && alt.trim().length > 0 ? alt.trim() : 'Billede';
    images.push({ src, description });
  }

  // ── Pass 2: walk the HTML and collect each visible text-node run ─────────
  //
  // Strategy: walk character by character maintaining a tag-vs-text state
  // machine. SKIP_CONTENT_TAGS suppress everything inside them. For each
  // contiguous run of text outside tags, emit the run as a separate entry.
  // (A "run" is the text between two consecutive tags or doc boundaries.)

  const runs: string[] = [];
  let buf: string[] = [];

  const flushBuf = () => {
    if (buf.length === 0) return;
    const trimmed = buf.join('').trim();
    if (trimmed) runs.push(trimmed);
    buf = [];
  };

  let i = 0;
  let skipDepth = 0;
  let skipTag = '';

  while (i < html.length) {
    if (html[i] !== '<') {
      if (skipDepth === 0) buf.push(html[i]);
      i++;
      continue;
    }

    const gtIdx = html.indexOf('>', i);
    if (gtIdx < 0) {
      // Malformed -- treat remainder as text if not skipping
      if (skipDepth === 0) buf.push(html.slice(i));
      break;
    }

    const tagContent = html.slice(i + 1, gtIdx);
    i = gtIdx + 1;

    const isClose = tagContent.trimStart().startsWith('/');
    const rawName = isClose
      ? tagContent.trimStart().slice(1).trim()
      : tagContent.trimStart();
    const spaceIdx = rawName.search(/[\s/]/);
    const tagName = (spaceIdx < 0 ? rawName : rawName.slice(0, spaceIdx)).toLowerCase();

    if (skipDepth > 0) {
      if (isClose && tagName === skipTag) {
        skipDepth--;
        if (skipDepth === 0) skipTag = '';
      } else if (!isClose && tagName === skipTag) {
        skipDepth++;
      }
      continue;
    }

    if (!isClose && SKIP_CONTENT_TAGS.has(tagName)) {
      skipDepth = 1;
      skipTag = tagName;
      flushBuf();
      continue;
    }

    // Tag boundary — flush whatever's in the buffer as a run.
    flushBuf();
  }
  // Trailing text without a closing tag
  flushBuf();

  // ── Pass 3: build the candidates list ────────────────────────────────────
  // Each text-run becomes one phrase entry. Each run is also tokenized into
  // its individual words so the picker offers both granularities (e.g. the
  // whole "Find me on Facebook" phrase AND the standalone words "Find" /
  // "Facebook"). Sort longer-first so the most specific bindings surface at
  // the top — phrases land above their constituent tokens.

  const candidates: string[] = [];
  const seenLower = new Set<string>();

  const tryAdd = (raw: string) => {
    if (!raw) return;
    const token = raw.replace(/^[-–—]+|[-–—]+$/g, '').trim();
    if (!token) return;
    if (/^\d+$/.test(token)) return;
    const lower = token.toLowerCase();
    if (seenLower.has(lower)) return;
    seenLower.add(lower);
    candidates.push(token);
  };

  for (const run of runs) {
    // Phrase: the whole run as a single bindable target.
    tryAdd(run);
    // Words within the run.
    const tokens = run.split(/[\s.,;:!?()\[\]{}<>'"\/\\|@#$%^&*+=~`]+/);
    for (const t of tokens) tryAdd(t);
  }

  // Split into words (≥2 chars of text-y content) and glyphs (single chars
  // or symbol-only entries like "▶", "@"). Glyphs are still bindable, just
  // categorized separately so the picker renders them under "BILLEDER".
  const words: string[] = [];
  const glyphs: string[] = [];
  for (const c of candidates) {
    if (isGlyphLike(c)) {
      glyphs.push(c);
    } else {
      words.push(c);
    }
  }

  // Sort each list longer-first while preserving insertion order within
  // the same length tier (stable sort on most modern JS engines).
  words.sort((a, b) => b.length - a.length);
  glyphs.sort((a, b) => b.length - a.length);

  // ── Pass 4: detect styled-button elements ────────────────────────────────
  // Buttons in email-signature HTML take a few shapes:
  //   • <a style="background:#...;padding:...">Find me on Facebook</a>
  //   • <td bgcolor="#1877f2"><a>Find me on Facebook</a></td>
  //   • <div style="background:#...">…</div>
  //   • <span style="background:#...">f</span>
  // We accept any of those: walk a-, td-, div-, span-, p-tag pairs and
  // capture each whose attributes carry a colored background (style or
  // legacy bgcolor attr). Length-cap the captured text so we don't pull
  // in the entire signature when an outer container has a faint background.
  const buttons: { text: string; bgColor: string }[] = [];
  const seenBtnText = new Set<string>();
  const buttonRe = /<(a|td|div|span|p)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const bm of html.matchAll(buttonRe)) {
    const attrs = bm[2];
    const inner = bm[3];

    // Find a colored background — either via inline style or the legacy
    // bgcolor attribute (Outlook-style <td bgcolor="#...">).
    let bgValue = '';
    const styleAttr = getAttr(attrs, 'style');
    if (styleAttr) {
      const bgMatch = styleAttr.match(/background(?:-color)?\s*:\s*([^;]+)/i);
      if (bgMatch) bgValue = bgMatch[1].trim();
    }
    if (!bgValue) {
      const bgcolorAttr = getAttr(attrs, 'bgcolor');
      if (bgcolorAttr) bgValue = bgcolorAttr.trim();
    }
    if (!bgValue) continue;

    // Reject transparent / pure-white / "none" — these are no-op resets,
    // not button backgrounds.
    if (/^(transparent|none|inherit|initial|unset)$/i.test(bgValue)) continue;
    if (/^(#fff(fff)?|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*1?\.?0*\s*\))$/i.test(bgValue)) continue;

    // Extract button text (strip nested tags, normalize whitespace).
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // Drop 1-char tokens (already in GLYPHS) and 2-char brand-mark stand-ins
    // ("in" for LinkedIn, "ig" for Instagram, "fb" for Facebook, "yt" for
    // YouTube, etc.). Those represent social icons whose URLs belong in the
    // socials array, not as standalone bindable buttons. Real CTA buttons in
    // signatures are at least three characters ("Læs", "Køb", "Find me…").
    if (text.length < 3) continue;
    // Reject runs longer than 80 chars: those are usually entire signature
    // containers with a faint background, not actual buttons.
    if (text.length > 80) continue;

    const lower = text.toLowerCase();
    if (seenBtnText.has(lower)) continue;
    seenBtnText.add(lower);
    buttons.push({ text, bgColor: bgValue });
    if (buttons.length >= 12) break;
  }

  return {
    words: words.slice(0, 50),
    glyphs: glyphs.slice(0, 30),
    buttons,
    images,
  };
}

/**
 * A "glyph-like" candidate is a single character OR a symbol-only entry
 * (no alphanumeric characters anywhere). These are usually icon stand-ins
 * Claude leaves behind ("f" inside an oval, "▶" play triangle, "@" mail
 * marker) and belong in the picker's image/icon section, not the text list.
 */
function isGlyphLike(s: string): boolean {
  if (s.length === 1) return true;
  // No latin letters, digits, or underscore anywhere → treat as symbol/emoji.
  if (!/[A-Za-z0-9_]/.test(s)) return true;
  return false;
}
