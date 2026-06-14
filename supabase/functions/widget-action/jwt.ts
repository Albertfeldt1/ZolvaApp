import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'https://esm.sh/jose@5.9.6';

const JWKS_URL = new URL(
  'https://auth.zolva.io/auth/v1/.well-known/jwks.json',
);

let jwks = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60 * 1000, // 10 min - Supabase rotation is rare
});

// Bind the token to this project's issuer + the authenticated-user audience.
// CONFIRMED 2026-06-14 by decoding freshly-minted tokens via BOTH the supabase.co
// URL and the custom domain (auth.zolva.io): GoTrue stamps the canonical
// `iss = https://sjkhfkatmeqtsrysixop.supabase.co/auth/v1` and `aud =
// authenticated` regardless of which host minted the token. We still accept the
// custom-domain issuer as a defensive fallback in case that ever changes.
const VERIFY_OPTS = {
  issuer: [
    'https://sjkhfkatmeqtsrysixop.supabase.co/auth/v1',
    'https://auth.zolva.io/auth/v1',
  ],
  audience: 'authenticated',
};

export type VerifiedJwt = {
  userId: string;
  payload: JWTPayload;
};

export async function verifyJwt(token: string | null): Promise<VerifiedJwt> {
  if (!token) throw new Error('missing token');
  try {
    const { payload } = await jwtVerify(token, jwks, VERIFY_OPTS);
    if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
    return { userId: payload.sub, payload };
  } catch (err) {
    // One-shot JWKS refresh + retry to handle key rotation between cold-start
    // cache and current Supabase keys.
    jwks = createRemoteJWKSet(JWKS_URL, {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000,
    });
    const { payload } = await jwtVerify(token, jwks, VERIFY_OPTS);
    if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
    return { userId: payload.sub, payload };
  }
}
