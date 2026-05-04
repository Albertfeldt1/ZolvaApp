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
  /** Distinct word tokens, length >= 3, not pure-numeric, cap 20, document-order. */
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

  // ── Pass 2: extract plain text, skipping tag attribute content ───────────
  //
  // Strategy: walk the HTML character by character maintaining a tiny
  // tag-vs-text state machine. When in a skip-with-content block
  // (script/style/...) suppress everything. Outside tags, collect text runs.
  // Inside a tag's < ... > boundary, discard (so attribute values are never
  // included in word extraction).

  const textParts: string[] = [];
  let i = 0;
  let skipDepth = 0;
  let skipTag = '';

  while (i < html.length) {
    if (html[i] !== '<') {
      // Plain text character
      if (skipDepth === 0) {
        textParts.push(html[i]);
      }
      i++;
      continue;
    }

    // We're at '<' -- find the end of this tag.
    const tagStart = i;
    const gtIdx = html.indexOf('>', i);
    if (gtIdx < 0) {
      // Malformed -- treat remainder as text if not skipping
      if (skipDepth === 0) textParts.push(html.slice(i));
      break;
    }

    const tagContent = html.slice(tagStart + 1, gtIdx); // content between < and >
    i = gtIdx + 1;

    // Determine if closing tag
    const isClose = tagContent.trimStart().startsWith('/');
    const rawName = isClose
      ? tagContent.trimStart().slice(1).trim()
      : tagContent.trimStart();
    // Extract just the tag name (up to first whitespace or end)
    const spaceIdx = rawName.search(/[\s/]/);
    const tagName = (spaceIdx < 0 ? rawName : rawName.slice(0, spaceIdx)).toLowerCase();

    if (skipDepth > 0) {
      // Inside a skipped block -- track nesting
      if (isClose && tagName === skipTag) {
        skipDepth--;
        if (skipDepth === 0) skipTag = '';
      } else if (!isClose && tagName === skipTag) {
        skipDepth++;
      }
      continue;
    }

    // Not currently skipping -- check if this tag starts a skip block
    if (!isClose && SKIP_CONTENT_TAGS.has(tagName)) {
      skipDepth = 1;
      skipTag = tagName;
      continue;
    }

    // For all other tags: discard tag (and its attributes) -- do NOT emit text.
    // Emit a space boundary so words don't merge across tags.
    textParts.push(' ');
  }

  const plainText = textParts.join('');

  // ── Pass 3: tokenize plain text into words ───────────────────────────────
  // Split on whitespace and common punctuation boundaries.
  const rawTokens = plainText.split(/[\s.,;:!?()\[\]{}<>'"\/\\|@#$%^&*+=~`]+/);

  const words: string[] = [];
  const seenLower = new Set<string>();

  for (const raw of rawTokens) {
    if (!raw) continue;
    // Strip any remaining leading/trailing dash punctuation
    const token = raw.replace(/^[-–—]+|[-–—]+$/g, '').trim();
    if (!token) continue;
    if (token.length < 3) continue;
    if (/^\d+$/.test(token)) continue;

    const lower = token.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    words.push(token);

    if (words.length >= 20) break;
  }

  return { words, images };
}
