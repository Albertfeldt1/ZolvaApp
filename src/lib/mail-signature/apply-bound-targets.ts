// src/lib/mail-signature/apply-bound-targets.ts
//
// Pure helper that applies bound-target social links to an imported HTML string.
// Walks `socials`, partitions into bound (target set) vs. unbound (target unset).
// For each bound link:
//   - 'word' target: finds the first occurrence of the literal text that is NOT
//     inside an existing <a>...</a> tag and NOT inside a tag attribute, then wraps
//     it with <a href="..."> using SOCIAL_COLORS for the colour.
//   - 'image' target: finds the first <img src="..."> whose src matches target.src
//     and wraps the entire <img> tag with <a href="...">.
// If the binding fails for any reason (not found, unsafe URL, already wrapped)
// the link is pushed to the unbound list.
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
 * Find the first occurrence of `word` (as a word-boundary match) in `html`
 * that is NOT inside a tag attribute and NOT inside an existing <a>...</a>.
 * Returns the match start index and the exact matched text, or null.
 */
function findFirstSafeWordMatch(
  html: string,
  word: string,
): { index: number; matched: string } | null {
  const aRanges = anchorRanges(html);
  const re = new RegExp(`\\b${escapeForRegex(word)}\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const idx = m.index;
    if (insideTag(html, idx)) continue;
    if (insideAnyRange(idx, aRanges)) continue;
    return { index: idx, matched: m[0] };
  }
  return null;
}

/**
 * Attempt to wrap the first safe occurrence of `word` in `html` with an <a>
 * tag. Returns the new html string on success, or null if the word was not
 * found in a bindable position.
 */
function wrapWord(
  html: string,
  word: string,
  href: string,
  color: string,
): string | null {
  const found = findFirstSafeWordMatch(html, word);
  if (!found) return null;
  const { index, matched } = found;
  const wrapped = `<a href="${escapeAttr(href)}" style="color:${color};text-decoration:underline">${matched}</a>`;
  return html.slice(0, index) + wrapped + html.slice(index + matched.length);
}

/**
 * Attempt to wrap the first <img> whose src matches `src` in `html` with an
 * <a> tag. Returns the new html string on success, or null.
 */
function wrapImage(
  html: string,
  src: string,
  href: string,
): string | null {
  // Find first <img ...> whose src attribute matches exactly `src`.
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const imgTag = m[0];
    const imgSrc = getAttr(imgTag, 'src');
    if (imgSrc !== src) continue;
    // Found -- check it's not already wrapped inside an <a>
    const idx = m.index;
    const aRanges = anchorRanges(html);
    if (insideAnyRange(idx, aRanges)) continue;
    // Wrap it
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
