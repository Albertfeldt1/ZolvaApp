import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'https://esm.sh/jose@5.9.6';

const JWKS_URL = new URL(
  'https://auth.zolva.io/auth/v1/.well-known/jwks.json',
);

let jwks = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60 * 1000, // 10 min - Supabase rotation is rare
});

// Bind the token to this project's issuer + the authenticated-user audience, so
// a same-JWKS token minted for a different purpose can't be replayed here.
// NOTE: the JWKS is served from the custom auth domain (auth.zolva.io) but the
// token `iss` claim is the canonical Supabase URL (verified via openid-config
// 2026-06-14). Do NOT change this to auth.zolva.io or all widget auth breaks.
const VERIFY_OPTS = {
  issuer: 'https://sjkhfkatmeqtsrysixop.supabase.co/auth/v1',
  audience: 'authenticated',
} as const;

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
