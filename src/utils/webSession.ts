import type { Request, Response, RequestHandler } from 'express';
import { allowedOrigins, isProduction } from '../middleware/securityHeaders.js';
import { requireAuth } from '../middleware/auth.js';
import { SESSION_TOKEN_TTL_SECONDS } from './token.js';

const COOKIE_NAME = 'pb_web_session';

function isWebSessionRequest(request: Request): boolean {
  const origin = request.header('origin');
  return request.header('x-web-session') === '1' && !!origin && (
    allowedOrigins().includes(origin) || origin === `${request.protocol}://${request.get('host')}`
  );
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: isProduction() ? 'none' as const : 'lax' as const,
    path: '/api/auth',
  };
}

export function saveWebSession(request: Request, response: Response, token: string): void {
  if (!isWebSessionRequest(request)) return;
  response.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: SESSION_TOKEN_TTL_SECONDS * 1000 });
}

export function clearWebSession(request: Request, response: Response): void {
  if (isWebSessionRequest(request)) response.clearCookie(COOKIE_NAME, cookieOptions());
}

export const deleteWebSession: RequestHandler = (request, response) => {
  if (!isWebSessionRequest(request)) {
    response.status(403).json({ message: 'Forbidden' });
    return;
  }
  clearWebSession(request, response);
  response.sendStatus(204);
};

export const restoreWebSession: RequestHandler = (request, response, next) => {
  if (!isWebSessionRequest(request)) {
    response.status(403).json({ message: 'Forbidden' });
    return;
  }
  const cookie = request.header('cookie')?.split(';').map((value) => value.trim())
    .find((value) => value.startsWith(`${COOKIE_NAME}=`));
  const token = cookie?.slice(COOKIE_NAME.length + 1);
  if (!token) {
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }
  request.headers.authorization = `Bearer ${token}`;
  void requireAuth(request, response, next);
};