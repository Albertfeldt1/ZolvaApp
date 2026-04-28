import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'https://esm.sh/jose@5.9.6';

const JWKS_URL = new URL(
  'https://sjkhfkatmeqtsrysixop.supabase.co/auth/v1/.well-known/jwks.json',
);

let jwks = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60 * 1000, // 10 min — Supabase rotation is rare
});

export type VerifiedJwt = {
  userId: string;
  payload: JWTPayload;
};

export async function verifyJwt(token: string | null): Promise<VerifiedJwt> {
  if (!token) throw new Error('missing token');
  try {
    const { payload } = await jwtVerify(token, jwks);
    if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
    return { userId: payload.sub, payload };
  } catch (err) {
    // One-shot JWKS refresh + retry to handle key rotation between cold-start
    // cache and current Supabase keys.
    jwks = createRemoteJWKSet(JWKS_URL, {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000,
    });
    const { payload } = await jwtVerify(token, jwks);
    if (typeof payload.sub !== 'string') throw new Error('jwt missing sub');
    return { userId: payload.sub, payload };
  }
}
