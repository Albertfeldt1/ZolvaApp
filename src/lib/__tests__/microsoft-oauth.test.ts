// Mock supabase + native crypto/web-browser before importing the SUT, matching
// the project convention (see reminders.test.ts).
jest.mock('../supabase', () => ({ supabase: { functions: { invoke: jest.fn() } } }));
jest.mock('expo-crypto', () => ({
  __esModule: true,
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
  // 32 deterministic bytes - enough for tests; actual randomness covered by manual smoke.
  getRandomBytes: (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i + 1)),
  digestStringAsync: jest.fn(async () => 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='),
}));
jest.mock('expo-web-browser', () => ({
  __esModule: true,
  openAuthSessionAsync: jest.fn(),
}));

import {
  generatePkce,
  parseMicrosoftCallback,
  rememberPendingVerifier,
  consumePendingVerifier,
  runMicrosoftOAuthWithDeps,
  MICROSOFT_REDIRECT_URI,
} from '../microsoft-oauth';

describe('generatePkce', () => {
  it('returns verifier in 43-128 char base64url range', async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe('parseMicrosoftCallback', () => {
  it('extracts code and state from query string', () => {
    const r = parseMicrosoftCallback('zolva://oauth/microsoft/callback?code=abc&state=xyz');
    expect(r).toEqual({ ok: true, code: 'abc', state: 'xyz' });
  });

  it('extracts code and state from URL fragment', () => {
    const r = parseMicrosoftCallback('zolva://oauth/microsoft/callback#code=abc&state=xyz');
    expect(r).toEqual({ ok: true, code: 'abc', state: 'xyz' });
  });

  it('surfaces error_description', () => {
    const r = parseMicrosoftCallback(
      'zolva://oauth/microsoft/callback?error=consent_required&error_description=AADSTS65001',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('AADSTS65001');
  });

  it('returns error when code missing', () => {
    const r = parseMicrosoftCallback('zolva://oauth/microsoft/callback?state=xyz');
    expect(r).toEqual({ ok: false, error: 'missing code in callback' });
  });

  it('returns error when state missing', () => {
    const r = parseMicrosoftCallback('zolva://oauth/microsoft/callback?code=abc');
    expect(r).toEqual({ ok: false, error: 'missing state in callback' });
  });

  it('rejects malformed URL', () => {
    const r = parseMicrosoftCallback('not a url at all');
    expect(r.ok).toBe(false);
  });
});

describe('verifier Map lifecycle', () => {
  it('remember + consume returns the same value once', () => {
    rememberPendingVerifier('s1', 'v1');
    expect(consumePendingVerifier('s1')).toBe('v1');
    expect(consumePendingVerifier('s1')).toBeNull();
  });
});

describe('runMicrosoftOAuthWithDeps', () => {
  const baseDeps = () => ({
    getClientId: (): string | null => 'client-x',
    openAuthSession: jest.fn(),
    invokeExchange: jest.fn(),
    getMailWatcherEnabled: () => true,
  });

  it('returns cancelled when WebBrowser cancels', async () => {
    const deps = baseDeps();
    deps.openAuthSession.mockResolvedValue({ type: 'cancel' });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(deps.invokeExchange).not.toHaveBeenCalled();
  });

  it('returns error when client_id missing', async () => {
    const deps = baseDeps();
    deps.getClientId = () => null;
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error.message).toContain('client_id missing');
  });

  it('surfaces Microsoft error_description from callback', async () => {
    const deps = baseDeps();
    let capturedAuthUrl = '';
    deps.openAuthSession.mockImplementation(async (url: string) => {
      capturedAuthUrl = url;
      return {
        type: 'success',
        url: 'zolva://oauth/microsoft/callback?error=consent_required&error_description=AADSTS65001%20admin',
      };
    });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error.message).toContain('AADSTS65001');
    expect(capturedAuthUrl).toContain('login.microsoftonline.com');
    expect(capturedAuthUrl).toContain('code_challenge_method=S256');
    expect(deps.invokeExchange).not.toHaveBeenCalled();
  });

  it('returns access_token on happy path', async () => {
    const deps = baseDeps();
    let capturedState = '';
    deps.openAuthSession.mockImplementation(async (url: string) => {
      const u = new URL(url);
      capturedState = u.searchParams.get('state') ?? '';
      return {
        type: 'success',
        url: `zolva://oauth/microsoft/callback?code=THE_CODE&state=${capturedState}`,
      };
    });
    deps.invokeExchange.mockResolvedValue({
      data: { access_token: 'AT', expires_in: 3600 },
      error: null,
    });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r).toEqual({ ok: true, accessToken: 'AT', expiresIn: 3600 });
    expect(deps.invokeExchange).toHaveBeenCalledWith({
      code: 'THE_CODE',
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      redirect_uri: MICROSOFT_REDIRECT_URI,
      mail_watcher_enabled: true,
    });
  });

  it('errors when exchange returns no access_token', async () => {
    const deps = baseDeps();
    deps.openAuthSession.mockImplementation(async (url: string) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      return { type: 'success', url: `zolva://oauth/microsoft/callback?code=c&state=${state}` };
    });
    deps.invokeExchange.mockResolvedValue({ data: {}, error: null });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error.message).toContain('No access_token');
  });

  it('errors with state mismatch when callback state was never issued', async () => {
    const deps = baseDeps();
    deps.openAuthSession.mockResolvedValue({
      type: 'success',
      url: 'zolva://oauth/microsoft/callback?code=c&state=NEVER_ISSUED',
    });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error.message).toContain('Forbindelsen blev afbrudt');
  });
});
