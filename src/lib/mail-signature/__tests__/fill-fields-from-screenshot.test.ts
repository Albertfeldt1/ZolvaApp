// src/lib/mail-signature/__tests__/fill-fields-from-screenshot.test.ts

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
  parseFillToolUse,
  mapFillError,
  fillResultMessage,
} from '../fill-fields-from-screenshot';
import { ClaudeRateLimitError, ClaudeConfigError } from '../../claude';

describe('parseFillToolUse', () => {
  const ok = {
    name: 'Albert Feldt',
    title: 'Founder',
    company: 'Zolva',
    phone: '+45 12 34 56 78',
    email: 'albert@zolva.io',
    website: 'zolva.io',
    customLines: 'CVR 12345678\nCopenhagen, DK',
    socials: [],
  };

  it('accepts a valid response with all fields populated', () => {
    expect(parseFillToolUse(ok)).toEqual({ ok: true, value: ok });
  });

  it('treats missing strings as empty strings', () => {
    const partial = { name: 'A', title: 'T' };
    const out = parseFillToolUse(partial);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toEqual({
        name: 'A',
        title: 'T',
        company: '',
        phone: '',
        email: '',
        website: '',
        customLines: '',
        socials: [],
      });
    }
  });

  it('coerces missing socials to []', () => {
    const out = parseFillToolUse({ name: 'A' });
    expect(out.ok && out.value.socials).toEqual([]);
  });

  it('drops socials with bad type or non-string url', () => {
    const input = {
      name: '',
      socials: [
        { type: 'linkedin', url: 'https://linkedin.com/in/a' },
        { type: 'invalid',  url: 'https://x.com' },
        { type: 'github' },
        { type: 'twitter', url: 42 },
      ],
    };
    const out = parseFillToolUse(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.socials).toEqual([
        { type: 'linkedin', url: 'https://linkedin.com/in/a' },
      ]);
    }
  });

  it('rejects non-object inputs', () => {
    expect(parseFillToolUse(null)).toEqual({ ok: false });
    expect(parseFillToolUse('string')).toEqual({ ok: false });
    expect(parseFillToolUse(42)).toEqual({ ok: false });
    expect(parseFillToolUse([])).toEqual({ ok: false });
  });

  it('rejects when a present field has the wrong type', () => {
    const bad = { name: 42 };
    expect(parseFillToolUse(bad)).toEqual({ ok: false });
  });
});

describe('mapFillError', () => {
  it('maps ClaudeRateLimitError to rate-limit', () => {
    expect(mapFillError(new ClaudeRateLimitError(60, 'rpm'))).toEqual({ ok: false, reason: 'rate-limit' });
  });
  it('maps ClaudeConfigError to unauthorized', () => {
    expect(mapFillError(new ClaudeConfigError())).toEqual({ ok: false, reason: 'unauthorized' });
  });
  it('maps a TypeError network failure to network', () => {
    expect(mapFillError(new TypeError('Network request failed'))).toEqual({ ok: false, reason: 'network' });
  });
  it('maps unknown errors to parse-failed', () => {
    expect(mapFillError(new Error('boom'))).toEqual({ ok: false, reason: 'parse-failed' });
    expect(mapFillError('string')).toEqual({ ok: false, reason: 'parse-failed' });
  });
});

describe('fillResultMessage', () => {
  it('returns Danish messages for each failure reason', () => {
    expect(fillResultMessage({ ok: false, reason: 'permission-denied' })).toContain('Indstillinger');
    expect(fillResultMessage({ ok: false, reason: 'cancelled' })).toBe('');
    expect(fillResultMessage({ ok: false, reason: 'too-large' })).toContain('for stort');
    expect(fillResultMessage({ ok: false, reason: 'no-data' })).toContain('felter');
    expect(fillResultMessage({ ok: false, reason: 'parse-failed' })).toContain('aflæse');
    expect(fillResultMessage({ ok: false, reason: 'network' })).toContain('forbindelse');
    expect(fillResultMessage({ ok: false, reason: 'rate-limit' })).toContain('forsøg');
    expect(fillResultMessage({ ok: false, reason: 'unauthorized' })).toContain('Log ind');
  });
});
