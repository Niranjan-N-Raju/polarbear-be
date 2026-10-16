import { jwtVerify } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import { User } from '../models/User.js';

export interface AuthInfo {
  id: string;
  role: string;
  name?: string;
  email?: string;
  sessionVersion: number;
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

  if (!token || !secret) {
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    }));
  } catch {
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const id = typeof payload.id === 'string' ? payload.id : null;
  if (!id) {
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }

  try {
    const user = await User.findById(id)
      .select('_id name email role isActive sessionVersion')
      .lean();
    const currentVersion = typeof user?.sessionVersion === 'number' ? user.sessionVersion : 0;
    const tokenVersion =
      typeof payload.sessionVersion === 'number' && Number.isInteger(payload.sessionVersion)
        ? payload.sessionVersion
        : 0;

    if (!user || user.isActive === false || !user.role || currentVersion !== tokenVersion) {
      response.status(401).json({ message: 'Unauthorized' });
      return;
    }

    request.auth = {
      id: String(user._id),
      role: user.role,
      name: user.name,
      email: user.email,
      sessionVersion: currentVersion,
    };
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