// src/lib/mail-signature/apply-bound-targets.ts
//
// Pure helper that applies bound-target social links to an imported HTML string.
// Walks `socials`, partitions into bound (target set) vs. unbound (target unset).
// For each bound link:
//   - 'word' target: finds the first occurrence of the literal text that is NOT
//     inside a tag attribute. If the match falls INSIDE an existing <a>...</a>
//     (Claude often invents fake hrefs around styled words like "her"), we
//     REPLACE that anchor's href with the user's URL — this is what the user
//     intends when they bind. Otherwise we wrap the match with a fresh <a>.
//   - 'image' target: finds the first <img src="..."> whose src matches
//     target.src and wraps it with <a href="...">; or replaces the surrounding
//     <a>'s href if the image is already inside one.
// If the binding fails (not found, unsafe URL, in an attribute) the link is
// pushed to the unbound list.
//
// No DOM dependency -- pure string operations only.

import type { SocialLink } from './types';
import { SOCIAL_COLORS, normalizeHref } from './template';

export function applyBoundTargets(input: {
  html: string;
  socials: SocialLink[];
}): { html: string; unbound: SocialLink[] } {
  const { socials } = input;
  let { html } = input;
  const unbound: SocialLink[] = [];

  for (const link of socials) {
    if (!link.target) {
      unbound.push(link);
      continue;
    }

    // Compute normalized href; skip/unbound if unsafe.
    const href = normalizeHref(link.url);
    if (!href) {
      unbound.push(link);
      continue;
    }

    const color = SOCIAL_COLORS[link.type];

    if (link.target.kind === 'word') {
      const word = link.target.text;
      const result = wrapWord(html, word, href, color);
      if (result === null) {
        unbound.push(link);
      } else {
        html = result;
      }
    } else {
      // kind === 'image'
      const src = link.target.src;
      const result = wrapImage(html, src, href);
      if (result === null) {
        unbound.push(link);
      } else {
        html = result;
      }
    }
  }

  return { html, unbound };
}

// -- Helpers ------------------------------------------------------------------

/**
 * Compute ranges [start, end) of all existing <a ...>...</a> spans in the html
 * so we can skip word matches that fall inside them.
 */
function anchorRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const openRe = /<a\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    const openEnd = openRe.lastIndex; // end of opening tag
    // Find the matching </a>
    const closeIdx = html.indexOf('</a>', openEnd);
    if (closeIdx < 0) {
      // Malformed -- treat the rest as covered to be safe
      ranges.push([m.index, html.length]);
    } else {
      ranges.push([m.index, closeIdx + '</a>'.length]);
    }
  }
  return ranges;
}

/**
 * Returns true if the given index falls inside any of the provided ranges.
 */
function insideAnyRange(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (idx >= start && idx < end) return true;
  }
  return false;
}

/**
 * Returns true if the given character index in `html` is inside a tag
 * (i.e. between < and >) -- which includes attribute values.
 */
function insideTag(html: string, idx: number): boolean {
  // Walk backwards from idx looking for the most recent unmatched '<' or '>'.
  for (let i = idx - 1; i >= 0; i--) {
    if (html[i] === '>') return false; // we're in text-node territory
    if (html[i] === '<') return true;  // we're inside a tag
  }
  return false;
}

/**
 * Escape string for use in a regex literal.
 */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the first occurrence of `word` in `html` that is NOT inside a tag
 * attribute. Returns the match position, matched text, and the surrounding
 * <a>...</a> range when applicable. Tag-attribute hits are skipped because
 * we never want to bind to text that lives inside `alt="..."` etc.
 *
 * Single-word targets use word-boundary matching (`\bfoo\b`) to avoid
 * accidentally wrapping inside longer words. Phrases (any target containing
 * whitespace or trailing non-word punctuation, e.g. "Find me on Facebook"
 * or "Let's connect!") use literal substring matching since `\b` doesn't
 * match next to non-word characters at the phrase boundary.
 */
function findFirstWordMatch(
  html: string,
  word: string,
): { index: number; matched: string; inAnchor: [number, number] | null } | null {
  const aRanges = anchorRanges(html);
  const escaped = escapeForRegex(word);
  // Detect if this target is a "simple word": purely word characters, no
  // whitespace, no punctuation. If so, anchor with \b on both sides.
  const isSimpleWord = /^[A-Za-z0-9_]+$/.test(word);
  const re = isSimpleWord
    ? new RegExp(`\\b${escaped}\\b`, 'gi')
    : new RegExp(escaped, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const idx = m.index;
    if (insideTag(html, idx)) continue;
    let inAnchor: [number, number] | null = null;
    for (const range of aRanges) {
      if (idx >= range[0] && idx < range[1]) {
        inAnchor = range;
        break;
      }
    }
    return { index: idx, matched: m[0], inAnchor };
  }
  return null;
}

/**
 * Attempt to wrap (or rewrite) the first match of `word` in `html` with an
 * <a> tag pointing at `href`. If the match is inside an existing <a>...</a>,
 * the existing anchor's opening tag is replaced (Claude often invents hrefs
 * around styled words and the user's bind is meant to override). Returns the
 * new html string on success, or null if the word can't be bound (only inside
 * tag attributes or not present at all).
 */
function wrapWord(
  html: string,
  word: string,
  href: string,
  color: string,
): string | null {
  const found = findFirstWordMatch(html, word);
  if (!found) return null;

  // Single plain words ("her", "Albert") get explicit link styling so they
  // visually read as a hyperlink in plain body text. Phrases — anything
  // with whitespace or non-word punctuation — are usually wrapping styled
  // block content (CTA buttons), so we emit a bare <a href> and let the
  // inner element's existing styling propagate. This keeps "Find me on
  // Facebook" looking like a button instead of becoming a blue underlined
  // link inside the button.
  const isSimpleWord = /^[A-Za-z0-9_]+$/.test(word);

  if (found.inAnchor) {
    // Existing <a ...> wraps the match. Preserve its existing attributes
    // (background, padding, font-weight, etc.) and just swap/insert the
    // href. This keeps button-styled anchors looking like buttons after
    // the user binds a new URL to them.
    const [aStart] = found.inAnchor;
    const openTagEnd = html.indexOf('>', aStart);
    if (openTagEnd <= 0) return null;
    const openTag = html.slice(aStart, openTagEnd + 1);
    const rewritten = setHrefOnTag(openTag, href);
    return html.slice(0, aStart) + rewritten + html.slice(openTagEnd + 1);
  }

  // No surrounding anchor — wrap the match with a fresh <a>...</a>.
  const newOpenTag = isSimpleWord
    ? `<a href="${escapeAttr(href)}" style="color:${color};text-decoration:underline">`
    : `<a href="${escapeAttr(href)}">`;
  const wrapped = `${newOpenTag}${found.matched}</a>`;
  return html.slice(0, found.index) + wrapped + html.slice(found.index + found.matched.length);
}

/**
 * Rewrite an opening <a ...> tag to set its href to the new value, preserving
 * every other attribute. If the tag has no href, one is inserted right after
 * the tag name. The leading "<a" and trailing ">" are preserved verbatim.
 */
function setHrefOnTag(openTag: string, newHref: string): string {
  // Match an existing href attribute (double-quoted, single-quoted, or unquoted).
  const hrefRe = /\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i;
  if (hrefRe.test(openTag)) {
    return openTag.replace(hrefRe, `href="${escapeAttr(newHref)}"`);
  }
  // No href yet — insert one immediately after "<a"
  return openTag.replace(/^<a\b/i, `<a href="${escapeAttr(newHref)}"`);
}

/**
 * Attempt to wrap (or rewrite) the first <img> whose src matches `src` in
 * `html` with an <a> tag. If the image is inside an existing <a>...</a>
 * (Claude often wraps logos with an invented company-website href), the
 * surrounding anchor's opening tag is replaced — same intent-override rule
 * as wrapWord. Returns the new html string on success, or null when the
 * image isn't present.
 */
function wrapImage(
  html: string,
  src: string,
  href: string,
): string | null {
  const imgRe = /<img\b[^>]*>/gi;
  const aRanges = anchorRanges(html);
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const imgTag = m[0];
    const imgSrc = getAttr(imgTag, 'src');
    if (imgSrc !== src) continue;
    const idx = m.index;
    let inAnchor: [number, number] | null = null;
    for (const range of aRanges) {
      if (idx >= range[0] && idx < range[1]) {
        inAnchor = range;
        break;
      }
    }
    if (inAnchor) {
      // Existing <a ...> wraps the image. Preserve its other attributes
      // (style, target, etc.) and just swap/insert the href so any logo
      // styling Claude applied stays intact.
      const [aStart] = inAnchor;
      const openTagEnd = html.indexOf('>', aStart);
      if (openTagEnd <= 0) return null;
      const openTag = html.slice(aStart, openTagEnd + 1);
      const rewritten = setHrefOnTag(openTag, href);
      return html.slice(0, aStart) + rewritten + html.slice(openTagEnd + 1);
    }
    // Not inside any anchor — wrap the <img> with a fresh <a>.
    const wrapped = `<a href="${escapeAttr(href)}">${imgTag}</a>`;
    return html.slice(0, idx) + wrapped + html.slice(idx + imgTag.length);
  }
  return null;
}

/**
 * Extract a named attribute value from an HTML tag string.
 */
function getAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3] ?? undefined;
}

/**
 * Minimal attribute value escaping (just double-quotes, which are the only
 * characters that could break out of a double-quoted attribute value here).
 */
function escapeAttr(s: string): string {
  return s.replaceAll('"', '&quot;');
}
