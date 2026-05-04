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
  it('removes 1-2 char styled <a> elements (squeezed icon stand-ins)', () => {
    const html = '<p>Hello</p><a style="background:#1877f2;padding:6px;color:#fff">f</a>';
    const out = stripIconStandIns(html);
    expect(out).not.toContain('background:#1877f2');
    expect(out).not.toContain('>f<');
    expect(out).toContain('Hello');
  });

  it('removes 1-2 char styled <td> with bgcolor', () => {
    const html = '<table><tr><td bgcolor="#000">X</td></tr></table>';
    const out = stripIconStandIns(html);
    expect(out).not.toContain('X</td>');
  });

  it('removes <span style="background:..."> with single-char content', () => {
    const html = 'before <span style="background:red">▶</span> after';
    const out = stripIconStandIns(html);
    expect(out).not.toContain('▶');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('keeps elements without a colored background even when text is short', () => {
    const html = '<p>X</p><span>Y</span>';
    const out = stripIconStandIns(html);
    expect(out).toContain('<p>X</p>');
    expect(out).toContain('<span>Y</span>');
  });

  it('keeps styled elements with longer text content', () => {
    const html = '<a style="background:#1877f2">Find me on Facebook</a>';
    const out = stripIconStandIns(html);
    expect(out).toContain('Find me on Facebook');
  });

  it('treats white / transparent backgrounds as no background', () => {
    const html = '<a style="background:white">f</a><div style="background:transparent">X</div>';
    const out = stripIconStandIns(html);
    expect(out).toContain('>f</a>');
    expect(out).toContain('>X</div>');
  });
});
