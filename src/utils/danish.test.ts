import { translateProviderError } from './danish';

describe('translateProviderError — AADSTS unmasking', () => {
  it('surfaces the AADSTS code even when the error also contains a 401/invalid_grant token', () => {
    // The real-world masked case: the Microsoft PKCE connect bounced back with an
    // AADSTS code wrapped in an invalid_grant/401 body. The AADSTS code is the
    // actionable signal and must NOT be hidden behind the generic "udløbet" copy.
    const err = new Error(
      'microsoft-oauth-exchange 401 invalid-code: microsoft refresh rejected: ' +
        '{"error":"invalid_grant","error_description":"AADSTS50011: The redirect URI specified in the request does not match."}',
    );
    const result = translateProviderError(err);
    expect(result.message).toContain('AADSTS50011');
  });

  it('still maps a genuine session expiry (401, no AADSTS) to the reconnect copy', () => {
    const err = new Error('401 unauthorized: jwt expired');
    const result = translateProviderError(err);
    expect(result.message).toBe('Din forbindelse er udløbet. Log ud og forbind igen.');
  });

  it('surfaces a plain AADSTS error with no 401 token', () => {
    const err = new Error('AADSTS65001: The user or administrator has not consented.');
    const result = translateProviderError(err);
    expect(result.message).toContain('AADSTS65001');
  });

  it('still detects network errors first', () => {
    const err = new Error('Network request failed');
    const result = translateProviderError(err);
    expect(result.kind).toBe('network');
  });
});
