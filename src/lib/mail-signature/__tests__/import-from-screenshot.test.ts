// Mock the claude module to avoid pulling in supabase / AsyncStorage native
// modules at test-module import time. We only need the two error classes.
jest.mock('../../claude', () => {
  class ClaudeRateLimitError extends Error {
    readonly retryAfterSec: number;
    readonly reason: 'rpm' | 'daily';
    constructor(retryAfterSec: number, reason: 'rpm' | 'daily') {
      super('rate limit');
      this.name = 'ClaudeRateLimitError';
      this.retryAfterSec = retryAfterSec;
      this.reason = reason;
    }
  }
  class ClaudeConfigError extends Error {
    constructor(message = 'config error') {
      super(message);
      this.name = 'ClaudeConfigError';
    }
  }
  return { ClaudeRateLimitError, ClaudeConfigError };
});

import {
  validateExtracted,
  mapClaudeError,
  importResultMessage,
  type ImportResult,
} from '../import-from-screenshot';
import { ClaudeRateLimitError, ClaudeConfigError } from '../../claude';

describe('validateExtracted', () => {
  const valid = {
    name: 'Albert Hangaard',
    title: 'CEO',
    company: 'Zolva',
    phone: '+45 12 34 56 78',
    email: 'albert@zolva.io',
    website: 'zolva.io',
    customLines: 'CVR 12345678',
  };

  it('returns ok with the data when all fields are valid strings', () => {
    const out = validateExtracted(valid);
    expect(out).toEqual({ ok: true, data: valid });
  });

  it('returns parse-failed when a required field is missing', () => {
    const broken = { ...valid } as Partial<typeof valid>;
    delete broken.email;
    expect(validateExtracted(broken)).toEqual({ ok: false, reason: 'parse-failed' });
  });

  it('returns parse-failed when a field is the wrong type', () => {
    expect(validateExtracted({ ...valid, name: null })).toEqual({ ok: false, reason: 'parse-failed' });
    expect(validateExtracted({ ...valid, phone: 42 })).toEqual({ ok: false, reason: 'parse-failed' });
    expect(validateExtracted({ ...valid, customLines: { foo: 'bar' } })).toEqual({ ok: false, reason: 'parse-failed' });
  });

  it('returns no-data when every field is empty after trim', () => {
    const empty = {
      name: '', title: '', company: '', phone: '', email: '', website: '', customLines: '   ',
    };
    expect(validateExtracted(empty)).toEqual({ ok: false, reason: 'no-data' });
  });

  it('ignores extra fields beyond the known seven', () => {
    const withExtra = { ...valid, somethingElse: 'ignored' };
    expect(validateExtracted(withExtra)).toEqual({ ok: true, data: valid });
  });

  it('returns parse-failed when input is not an object', () => {
    expect(validateExtracted(null)).toEqual({ ok: false, reason: 'parse-failed' });
    expect(validateExtracted('a string')).toEqual({ ok: false, reason: 'parse-failed' });
    expect(validateExtracted(42)).toEqual({ ok: false, reason: 'parse-failed' });
  });
});

describe('mapClaudeError', () => {
  it('maps ClaudeRateLimitError to rate-limit', () => {
    const err = new ClaudeRateLimitError(60, 'rpm');
    expect(mapClaudeError(err)).toEqual({ ok: false, reason: 'rate-limit' });
  });

  it('maps ClaudeConfigError to unauthorized', () => {
    const err = new ClaudeConfigError();
    expect(mapClaudeError(err)).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('maps a TypeError-like network failure to network', () => {
    expect(mapClaudeError(new TypeError('Network request failed'))).toEqual({ ok: false, reason: 'network' });
  });

  it('maps a generic Error to parse-failed (Claude returned something unparseable)', () => {
    expect(mapClaudeError(new Error('JSON.parse failed'))).toEqual({ ok: false, reason: 'parse-failed' });
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
