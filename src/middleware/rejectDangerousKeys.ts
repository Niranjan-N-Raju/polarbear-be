import type { RequestHandler } from 'express';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 20;

/**
 * Returns the first key that could be interpreted as a MongoDB operator, a dotted
 * path, or a prototype-pollution vector. `JSON.parse` keeps `__proto__` as an own
 * property, so `Object.keys` is sufficient to see it.
 */
export function findDangerousKey(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return '(nesting too deep)';
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDangerousKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.') || FORBIDDEN_KEYS.has(key)) return key;
    const found = findDangerousKey((value as Record<string, unknown>)[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export const rejectDangerousKeys: RequestHandler = (request, response, next) => {
  if (findDangerousKey(request.body)) {
    response.status(400).json({ message: 'Request contains unsupported field names.' });
    return;
  }
  next();
};
