import { jwtVerify } from 'jose';
import mongoose from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import { User } from '../models/User.js';
import { SESSION_ABSOLUTE_MAX_SECONDS, SESSION_AUDIENCE, SESSION_ISSUER } from '../utils/token.js';

export interface AuthInfo {
  id: string;
  role: string;
  name?: string;
  email?: string;
  sessionVersion: number;
  sessionStart: number;
  mustChangePassword?: boolean;
}

// Routes a user who still holds an admin-issued password may reach: read/update own profile
// (the password change itself), extend and log out. Everything else is refused until the
// password is replaced.
const PASSWORD_CHANGE_ALLOWED = new Set([
  'GET /api/me',
  'PATCH /api/me',
  'POST /api/auth/logout',
  'POST /api/auth/extend',
]);

function routeKey(request: Request): string {
  const path = (request.originalUrl.split('?')[0] ?? '').replace(/\/+$/, '').toLowerCase();
  return `${request.method.toUpperCase()} ${path}`;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

export async function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const authorization = request.header('authorization');
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const secret = process.env.JWT_SECRET;

  if (!token || !secret || secret.length < 32) {
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      requiredClaims: ['exp', 'iat', 'id', 'sessionVersion', 'sessionStart'],
      maxTokenAge: '8h',
    }));
  } catch {
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const id = typeof payload.id === 'string' ? payload.id : null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sessionStart = Number.isSafeInteger(payload.sessionStart) ? Number(payload.sessionStart) : NaN;
  if (!id || !mongoose.isObjectIdOrHexString(id) ||
      !Number.isSafeInteger(payload.sessionVersion) || Number(payload.sessionVersion) < 0 ||
      !Number.isSafeInteger(sessionStart) || sessionStart > nowSeconds + 60 ||
      sessionStart > Number(payload.iat) + 60 ||
      nowSeconds - sessionStart > SESSION_ABSOLUTE_MAX_SECONDS) {
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }

  try {
    const user = await User.findById(id)
      .select('_id name email role isActive sessionVersion mustChangePassword')
      .lean();
    const currentVersion = typeof user?.sessionVersion === 'number' ? user.sessionVersion : 0;
    const tokenVersion =
      typeof payload.sessionVersion === 'number' && Number.isInteger(payload.sessionVersion)
        ? payload.sessionVersion
        : -1;

    if (!user || user.isActive === false ||
        !['admin', 'sub_admin', 'franchise_admin', 'employee'].includes(user.role) ||
        currentVersion !== tokenVersion) {
      response.status(401).json({ message: 'Unauthorized' });
      return;
    }

    request.auth = {
      id: String(user._id),
      role: user.role,
      name: user.name,
      email: user.email,
      sessionVersion: currentVersion,
      sessionStart,
      mustChangePassword: user.mustChangePassword === true,
    };
    if (user.mustChangePassword === true && !PASSWORD_CHANGE_ALLOWED.has(routeKey(request))) {
      response.status(403).json({
        message: 'You must change your password before continuing.',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles: string[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.auth || !roles.includes(request.auth.role)) {
      response.status(request.auth ? 403 : 401).json({
        message: request.auth ? 'Forbidden' : 'Unauthorized',
      });
      return;
    }
    next();
  };
}