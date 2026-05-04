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
   * Bindable text fragments — every distinct piece of visible content in the
   * imported HTML, including:
   *   • single tokens of any length (e.g. "f", "X", "Albert")
   *   • whole text-node phrases (e.g. "Find me on Facebook", "Let's connect!")
   * Sorted longer-first so the most specific phrases surface at the top of
   * the bind picker. Cap at 50 entries, document-order within length tiers.
   */
  words: string[];
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
    return { words: [], images: [] };
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

  // Sort longer-first while preserving insertion order within the same
  // length tier (stable sort on most modern JS engines).
  candidates.sort((a, b) => b.length - a.length);

  const words = candidates.slice(0, 50);

  return { words, images };
}
