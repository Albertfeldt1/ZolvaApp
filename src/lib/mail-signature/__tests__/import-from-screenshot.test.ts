// src/lib/mail-signature/__tests__/import-from-screenshot.test.ts

jest.mock('../../claude', () => {
  class ClaudeRateLimitErrorMock extends Error {
    readonly retryAfterSec: number;
    readonly reason: 'rpm' | 'daily';
    constructor(retryAfterSec: number, reason: 'rpm' | 'daily') {
      super('rate limit');
      this.name = 'ClaudeRateLimitError';
      this.retryAfterSec = retryAfterSec;
      this.reason = reason;
    }
  }
  class ClaudeConfigErrorMock extends Error {
    constructor() {
      super('config');
      this.name = 'ClaudeConfigError';
    }
  }
  return {
    ClaudeRateLimitError: ClaudeRateLimitErrorMock,
    ClaudeConfigError: ClaudeConfigErrorMock,
    completeWithTool: jest.fn(),
  };
});

import {
  parseImportToolUse,
  mapClaudeError,
  importResultMessage,
  stripIconStandIns,
  stripCidImageReferences,
} from '../import-from-screenshot';
import { ClaudeRateLimitError, ClaudeConfigError } from '../../claude';

describe('parseImportToolUse', () => {
  const ok = {
    html: '<table><tr><td>Hi</td></tr></table>',
    plaintext: 'Hi',
    logoBox: null,
  };

  it('accepts a valid no-logo response', () => {
    expect(parseImportToolUse(ok)).toEqual({ ok: true, value: { ...ok, socials: [] } });
  });

  it('accepts a valid with-logo response', () => {
    const withLogo = { ...ok, logoBox: { x: 10, y: 20, w: 100, h: 50 } };
    expect(parseImportToolUse(withLogo)).toEqual({ ok: true, value: { ...withLogo, socials: [] } });
  });

  it('rejects missing html', () => {
    const bad = { plaintext: 'x', logoBox: null };
    expect(parseImportToolUse(bad)).toEqual({ ok: false });
  });

  it('rejects missing plaintext', () => {
    const bad = { html: '<x>', logoBox: null };
    expect(parseImportToolUse(bad)).toEqual({ ok: false });
  });

  it('rejects logoBox with non-number fields', () => {
    const bad = { ...ok, logoBox: { x: 'a', y: 0, w: 0, h: 0 } };
    expect(parseImportToolUse(bad)).toEqual({ ok: false });
  });

  it('rejects non-object inputs', () => {
    expect(parseImportToolUse(null)).toEqual({ ok: false });
    expect(parseImportToolUse('a string')).toEqual({ ok: false });
    expect(parseImportToolUse(42)).toEqual({ ok: false });
  });

  it('accepts a socials array with valid items', () => {
    const okWithSocials = {
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      logoBox: null,
      socials: [
        { type: 'linkedin', url: 'https://linkedin.com/in/albert' },
        { type: 'github',   url: 'https://github.com/albert' },
      ],
    };
    const out = parseImportToolUse(okWithSocials);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.socials).toEqual(okWithSocials.socials);
    }
  });

  it('drops socials items with bad type or missing url', () => {
    const input = {
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      logoBox: null,
      socials: [
        { type: 'linkedin', url: 'https://linkedin.com/in/albert' },  // ok
        { type: 'invalid',  url: 'https://x.com' },                    // bad type
        { type: 'github' },                                            // missing url
        { type: 'twitter', url: 42 },                                  // non-string url
      ],
    };
    const out = parseImportToolUse(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.socials).toEqual([
        { type: 'linkedin', url: 'https://linkedin.com/in/albert' },
      ]);
    }
  });

  it('treats missing socials field as empty array', () => {
    const input = {
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      logoBox: null,
    };
    const out = parseImportToolUse(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.socials).toEqual([]);
    }
  });
});

describe('mapClaudeError', () => {
  it('maps ClaudeRateLimitError to rate-limit', () => {
    expect(mapClaudeError(new ClaudeRateLimitError(60, 'rpm'))).toEqual({ ok: false, reason: 'rate-limit' });
  });

  it('maps ClaudeConfigError to unauthorized', () => {
    expect(mapClaudeError(new ClaudeConfigError())).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('maps a TypeError network failure to network', () => {
    expect(mapClaudeError(new TypeError('Network request failed'))).toEqual({ ok: false, reason: 'network' });
  });

  it('maps a generic Error to parse-failed', () => {
    expect(mapClaudeError(new Error('boom'))).toEqual({ ok: false, reason: 'parse-failed' });
  });

  it('maps unknown thrown values to parse-failed', () => {
    expect(mapClaudeError('string error')).toEqual({ ok: false, reason: 'parse-failed' });
    expect(mapClaudeError(undefined)).toEqual({ ok: false, reason: 'parse-failed' });
  });
});

describe('importResultMessage', () => {
  it('returns Danish messages for each failure reason', () => {
    expect(importResultMessage({ ok: false, reason: 'permission-denied' })).toContain('Indstillinger');
    expect(importResultMessage({ ok: false, reason: 'cancelled' })).toBe('');
    expect(importResultMessage({ ok: false, reason: 'too-large' })).toContain('for stort');
    expect(importResultMessage({ ok: false, reason: 'no-data' })).toContain('aflæse felter');
    expect(importResultMessage({ ok: false, reason: 'parse-failed' })).toContain('aflæse billedet');
    expect(importResultMessage({ ok: false, reason: 'network' })).toContain('forbindelse');
    expect(importResultMessage({ ok: false, reason: 'rate-limit' })).toContain('forsøg');
    expect(importResultMessage({ ok: false, reason: 'unauthorized' })).toContain('Log ind');
  });
});

describe('stripIconStandIns', () => {
  it('keeps 1-2 char styled elements (legitimate contact-line icons stay)', () => {
    const html = '<p>Hello</p><a style="background:#1877f2;padding:6px;color:#fff">f</a>';
    const out = stripIconStandIns(html);
    expect(out).toContain('background:#1877f2');
    expect(out).toContain('>f<');
  });

  it('keeps inline contact-line icons with single-char content', () => {
    const html = '<span style="background:#0a66c2">📞</span> +45 12 34 56 78';
    const out = stripIconStandIns(html);
    expect(out).toContain('📞');
    expect(out).toContain('background:#0a66c2');
  });

  it('strips empty styled elements (decorative shapes, SVG remnants)', () => {
    const html = '<p>before</p><div style="background:#1877f2;width:30px;height:30px;border-radius:50%"></div><p>after</p>';
    const out = stripIconStandIns(html);
    expect(out).not.toContain('background:#1877f2');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('keeps elements without a colored background even when empty', () => {
    const html = '<p>X</p><span></span>';
    const out = stripIconStandIns(html);
    expect(out).toContain('<p>X</p>');
    expect(out).toContain('<span></span>');
  });

  it('keeps styled elements with longer text content', () => {
    const html = '<a style="background:#1877f2">Find me on Facebook</a>';
    const out = stripIconStandIns(html);
    expect(out).toContain('Find me on Facebook');
  });

  it('keeps a styled element that wraps a real <img> (button-with-icon pattern)', () => {
    const html = '<a style="background:#000"><img src="cid:zolva-sig"></a>';
    const out = stripIconStandIns(html);
    expect(out).toContain('cid:zolva-sig');
    expect(out).toContain('background:#000');
  });

  it('iteratively cleans empty wrappers - strips inner cells then the empty row/table', () => {
    const html = '<table style="background:#1c2e3a"><tr><td style="background:#1c2e3a"></td><td style="background:#1c2e3a"></td></tr></table>';
    const out = stripIconStandIns(html);
    // Inner empty styled <td>s gone first, then empty <tr>, then empty <table>
    expect(out).not.toContain('table');
    expect(out).not.toContain('background:#1c2e3a');
  });

  it('drops empty <tr> / <table> even without a colored background', () => {
    const html = '<table><tr></tr></table><p>after</p>';
    const out = stripIconStandIns(html);
    expect(out).not.toContain('<table>');
    expect(out).not.toContain('<tr>');
    expect(out).toContain('after');
  });
});

describe('stripCidImageReferences', () => {
  it('removes a bare cid:zolva-sig <img>', () => {
    const html = '<p>before</p><img src="cid:zolva-sig"><p>after</p>';
    expect(stripCidImageReferences(html)).toBe('<p>before</p><p>after</p>');
  });

  it('removes a cid:zolva-sig <img> with attributes', () => {
    const html = '<img src="cid:zolva-sig" alt="" width="50" height="50" style="display:block">Hello';
    expect(stripCidImageReferences(html)).toBe('Hello');
  });

  it('handles single-quoted src', () => {
    const html = `<img src='cid:zolva-sig' alt=''>X`;
    expect(stripCidImageReferences(html)).toBe('X');
  });

  it('keeps non-cid <img> tags', () => {
    const html = '<img src="https://example.com/logo.png"><img src="cid:zolva-sig">';
    const out = stripCidImageReferences(html);
    expect(out).toContain('https://example.com/logo.png');
    expect(out).not.toContain('cid:zolva-sig');
  });

  it('removes multiple references', () => {
    const html = '<img src="cid:zolva-sig">A<img src="cid:zolva-sig">B';
    expect(stripCidImageReferences(html)).toBe('AB');
  });
});
