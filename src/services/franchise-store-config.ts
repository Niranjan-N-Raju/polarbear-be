import type { Request, Response } from 'express';
import { bodyRecord } from '../utils/franchiseRoute.js';
import { authorizeStore } from '../utils/storeAccess.js';
export const MAX_LOGO_SIZE = 2 * 1024 * 1024;
export const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const SHIFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
export const ALLOWED_LOGO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export async function getStoreId(request: Request, response: Response) {
  const body = bodyRecord(request);
  const queryId = request.query.storeId ?? request.query.franchiseId;
  const storeId = typeof queryId === 'string' ? queryId : body.storeId ?? body.franchiseId;
  return authorizeStore(storeId, request.auth!.id, response);
}
