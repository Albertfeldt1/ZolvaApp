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
} from '../import-from-screenshot';
import { ClaudeRateLimitError, ClaudeConfigError } from '../../claude';

describe('parseImportToolUse', () => {
  const ok = {
    html: '<table><tr><td>Hi</td></tr></table>',
    plaintext: 'Hi',
    logoBox: null,
  };

  it('accepts a valid no-logo response', () => {
    expect(parseImportToolUse(ok)).toEqual({ ok: true, value: ok });
  });

  it('accepts a valid with-logo response', () => {
    const withLogo = { ...ok, logoBox: { x: 10, y: 20, w: 100, h: 50 } };
    expect(parseImportToolUse(withLogo)).toEqual({ ok: true, value: withLogo });
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
