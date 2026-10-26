import { SignJWT } from 'jose';

export const SESSION_ISSUER = 'polar-bear-backend';
export const SESSION_AUDIENCE = 'polar-bear-api';
export const SESSION_TOKEN_TTL_SECONDS = 8 * 60 * 60;
export const SESSION_ABSOLUTE_MAX_SECONDS = 24 * 60 * 60;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
  sessionVersion?: number;
  /** Epoch seconds of the original login; preserved across /auth/extend. */
  sessionStart?: number;
}

export async function signSessionToken(user: SessionUser): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required.');
  const now = Math.floor(Date.now() / 1000);
  const sessionStart = user.sessionStart ?? now;
  const absoluteExpiry = sessionStart + SESSION_ABSOLUTE_MAX_SECONDS;
  return new SignJWT({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sessionVersion: user.sessionVersion ?? 0,
    sessionStart,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.min(now + SESSION_TOKEN_TTL_SECONDS, absoluteExpiry))
    .sign(new TextEncoder().encode(secret));
}