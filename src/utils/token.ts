import { SignJWT } from 'jose';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
  sessionVersion?: number;
}

export async function signSessionToken(user: SessionUser): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required.');
  return new SignJWT({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sessionVersion: user.sessionVersion ?? 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('8h')
    .sign(new TextEncoder().encode(secret));
}