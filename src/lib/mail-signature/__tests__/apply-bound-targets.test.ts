// src/lib/mail-signature/__tests__/apply-bound-targets.test.ts

import { applyBoundTargets } from '../apply-bound-targets';
import type { SocialLink } from '../types';

describe('applyBoundTargets', () => {
  // ── Trivial cases ──────────────────────────────────────────────────────────

  it('empty socials → returns html unchanged, unbound = []', () => {
    const html = '<p>Hello world</p>';
    const result = applyBoundTargets({ html, socials: [] });
    expect(result.html).toBe(html);
    expect(result.unbound).toEqual([]);
  });

  it('all-unbound socials → returns html unchanged, unbound = original list', () => {
    const html = '<p>Hello world</p>';
    const socials: SocialLink[] = [
      { type: 'linkedin', url: 'https://linkedin.com/in/albert' },
      { type: 'github', url: 'https://github.com/albert' },
    ];
    const result = applyBoundTargets({ html, socials });
    expect(result.html).toBe(html);
    expect(result.unbound).toEqual(socials);
  });

  // ── Word binding ───────────────────────────────────────────────────────────

  it('one bound word found in html → word wrapped, unbound = []', () => {
    const html = '<p>Se mere her på vores hjemmeside</p>';
    const socials: SocialLink[] = [
      {
        type: 'website',
        url: 'https://example.com',
        target: { kind: 'word', text: 'her' },
      },
    ];
    const result = applyBoundTargets({ html, socials });
    expect(result.html).toContain('<a href="https://example.com"');
    expect(result.html).toContain('>her</a>');
    expect(result.unbound).toEqual([]);
  });

  it('one bound word not found → html unchanged, unbound = [the link]', () => {
    const html = '<p>Hello world</p>';
    const link: SocialLink = {
      type: 'linkedin',
      url: 'https://linkedin.com',
      target: { kind: 'word', text: 'missing' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    expect(result.html).toBe(html);
    expect(result.unbound).toEqual([link]);
  });

  it('bound word inside an existing <a>…</a> → REPLACES the existing href (Claude often invents fake hrefs around styled words)', () => {
    const html = '<p>Check <a href="http://old.com">her</a> for info</p>';
    const link: SocialLink = {
      type: 'website',
      url: 'https://example.com',
      target: { kind: 'word', text: 'her' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    // Old href is gone, replaced with the user's URL. Inner content
    // ("her") is preserved.
    expect(result.html).not.toContain('http://old.com');
    expect(result.html).toContain('href="https://example.com"');
    expect(result.html).toMatch(/<a [^>]*>her<\/a>/);
    expect(result.unbound).toEqual([]);
  });

  it('bound word inside an existing <a>…</a> preserves its other attributes - only the href is swapped', () => {
    const html = '<p><a href="http://x" target="_blank" data-x="y" style="color:red">her</a></p>';
    const link: SocialLink = {
      type: 'linkedin',
      url: 'https://example.com',
      target: { kind: 'word', text: 'her' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    // Old href is gone, replaced with the user's URL.
    expect(result.html).not.toContain('http://x');
    expect(result.html).toContain('href="https://example.com"');
    // Every other attribute (and any inline button styling) survives so a
    // styled-anchor button doesn't lose its visual.
    expect(result.html).toContain('target="_blank"');
    expect(result.html).toContain('data-x="y"');
    expect(result.html).toContain('style="color:red"');
    expect(result.unbound).toEqual([]);
  });

  it('bound word found but inside a tag attribute (alt="her") → html unchanged, unbound = [the link]', () => {
    const html = '<img src="photo.jpg" alt="her"><p>something else</p>';
    const link: SocialLink = {
      type: 'website',
      url: 'https://example.com',
      target: { kind: 'word', text: 'her' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    // "her" only appears inside alt attribute, so should not be wrapped
    expect(result.html).toBe(html);
    expect(result.unbound).toEqual([link]);
  });

  it('bound word found in text after an attribute with same text → wraps the text node occurrence', () => {
    // alt="her" appears first, but "her" in text node after should be bound
    const html = '<img src="photo.jpg" alt="her"><p>Click her for info</p>';
    const link: SocialLink = {
      type: 'website',
      url: 'https://example.com',
      target: { kind: 'word', text: 'her' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    // The word in the text node should be wrapped
    expect(result.html).toContain('<a href="https://example.com"');
    expect(result.html).toContain('>her</a>');
    // The alt attribute should not be changed
    expect(result.html).toContain('alt="her"');
    expect(result.unbound).toEqual([]);
  });

  // ── Image binding ──────────────────────────────────────────────────────────

  it('one bound image found by src → img wrapped in <a>, unbound = []', () => {
    const html = '<table><tr><td><img src="cid:zolva-sig" alt="" width="100"></td></tr></table>';
    const link: SocialLink = {
      type: 'website',
      url: 'https://example.com',
      target: { kind: 'image', src: 'cid:zolva-sig' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    expect(result.html).toContain('<a href="https://example.com"><img src="cid:zolva-sig"');
    expect(result.html).toContain('</a>');
    expect(result.unbound).toEqual([]);
  });

  it('one bound image, src not found → html unchanged, unbound = [the link]', () => {
    const html = '<p>No image here</p>';
    const link: SocialLink = {
      type: 'website',
      url: 'https://example.com',
      target: { kind: 'image', src: 'cid:zolva-sig' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    expect(result.html).toBe(html);
    expect(result.unbound).toEqual([link]);
  });

  it('bound image inside an existing <a>…</a> → REPLACES the existing href (Claude often wraps logos with an invented company URL)', () => {
    const html = '<p><a href="http://invented.example">' +
      '<img src="cid:zolva-sig" alt="logo">' +
      '</a></p>';
    const link: SocialLink = {
      type: 'website',
      url: 'https://example.com',
      target: { kind: 'image', src: 'cid:zolva-sig' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    expect(result.html).not.toContain('http://invented.example');
    expect(result.html).toContain('href="https://example.com"');
    expect(result.html).toContain('<img src="cid:zolva-sig" alt="logo">');
    expect(result.unbound).toEqual([]);
  });

  // ── Mixed bound + unbound ──────────────────────────────────────────────────

  it('mixed bound + unbound → html has binding applied, unbound = unbound + failed targets', () => {
    const html = '<p>Check her for details</p>';
    const boundLink: SocialLink = {
      type: 'linkedin',
      url: 'https://linkedin.com/in/albert',
      target: { kind: 'word', text: 'her' },
    };
    const unboundLink: SocialLink = {
      type: 'github',
      url: 'https://github.com/albert',
    };
    const missingLink: SocialLink = {
      type: 'twitter',
      url: 'https://twitter.com/albert',
      target: { kind: 'word', text: 'missing' },
    };
    const result = applyBoundTargets({ html, socials: [boundLink, unboundLink, missingLink] });
    expect(result.html).toContain('<a href="https://linkedin.com/in/albert"');
    expect(result.html).toContain('>her</a>');
    expect(result.unbound).toHaveLength(2);
    expect(result.unbound).toContain(unboundLink);
    expect(result.unbound).toContain(missingLink);
  });

  // ── URL normalization ──────────────────────────────────────────────────────

  it('bound word link with no scheme → href in output is https://...', () => {
    const html = '<p>Visit her for info</p>';
    const link: SocialLink = {
      type: 'website',
      url: 'example.com',
      target: { kind: 'word', text: 'her' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    expect(result.html).toContain('href="https://example.com"');
    expect(result.unbound).toEqual([]);
  });

  it('dangerous URL (javascript:) on a bound link → skipped, link pushed to unbound', () => {
    const html = '<p>Click her please</p>';
    const link: SocialLink = {
      type: 'website',
      url: 'javascript:alert(1)',
      target: { kind: 'word', text: 'her' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    // html must be unchanged - no wrapping for dangerous URLs
    expect(result.html).toBe(html);
    expect(result.unbound).toEqual([link]);
  });

  // ── Colour from SOCIAL_COLORS ─────────────────────────────────────────────

  it('word binding uses the SOCIAL_COLORS color for the link type', () => {
    const html = '<p>Visit her to connect</p>';
    const link: SocialLink = {
      type: 'linkedin',
      url: 'https://linkedin.com/in/test',
      target: { kind: 'word', text: 'her' },
    };
    const result = applyBoundTargets({ html, socials: [link] });
    // LinkedIn color is #0a66c2
    expect(result.html).toContain('color:#0a66c2');
  });
});
