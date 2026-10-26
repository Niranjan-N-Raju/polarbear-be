import type { NextFunction, Request, Response } from 'express';

interface RateLimitEntry {
  count: number;
  firstAt: number;
  lockedUntil?: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxAttempts: number;
  lockoutMs: number;
}

// Process-local store. Each API instance enforces its own budget, so a multi-instance
// deployment must add an edge/WAF limit or a shared store (see ABUSE-RESISTANCE-AUDIT.md).
const entries = new Map<string, RateLimitEntry>();
const MAX_ENTRIES = 10_000;
const MAX_ENTRY_AGE_MS = 2 * 60 * 60_000;

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.firstAt > MAX_ENTRY_AGE_MS && (!entry.lockedUntil || now >= entry.lockedUntil)) entries.delete(key);
  }
  // Still over the cap (flood of distinct keys): evict oldest unlocked entries first so a flood cannot lift active lockouts.
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_ENTRIES) break;
    if (!entry.lockedUntil || now >= entry.lockedUntil) entries.delete(key);
  }
  for (const key of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    entries.delete(key);
  }
}

export function rateLimitEntryCount(): number {
  return entries.size;
}

export function resetRateLimit(key: string): void {
  entries.delete(key);
}

export function resetRateLimitsForTests(): void {
  entries.clear();
}

function freshEntry(current: RateLimitEntry | undefined, now: number, config: RateLimitConfig): boolean {
  return !current || now - current.firstAt > config.windowMs || (current.lockedUntil !== undefined && now >= current.lockedUntil);
}

export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  if (entries.size >= MAX_ENTRIES) prune(now);
  const current = entries.get(key);

  if (current?.lockedUntil && now < current.lockedUntil) {
    return { allowed: false, retryAfterMs: current.lockedUntil - now };
  }

  if (freshEntry(current, now, config)) {
    entries.set(key, { count: 1, firstAt: now });
    return { allowed: true };
  }

  current!.count += 1;
  if (current!.count > config.maxAttempts) {
    current!.lockedUntil = now + config.lockoutMs;
    return { allowed: false, retryAfterMs: config.lockoutMs };
  }

  return { allowed: true };
}

/** Reports an active lockout without consuming budget (used for failure-only counters). */
export function peekRateLimit(key: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const current = entries.get(key);
  if (current?.lockedUntil && now < current.lockedUntil) {
    return { allowed: false, retryAfterMs: current.lockedUntil - now };
  }
  return { allowed: true };
}

/** Records one failure; the key locks once `maxAttempts` failures occur inside the window. */
export function recordRateLimitFailure(key: string, config: RateLimitConfig): void {
  const now = Date.now();
  if (entries.size >= MAX_ENTRIES) prune(now);
  const current = entries.get(key);
  if (current?.lockedUntil && now < current.lockedUntil) return;
  const entry = freshEntry(current, now, config) ? { count: 0, firstAt: now } : current!;
  entry.count += 1;
  entry.lockedUntil = entry.count >= config.maxAttempts ? now + config.lockoutMs : undefined;
  entries.set(key, entry);
}

export function sendRateLimited(response: Response, retryAfterMs = 60_000, message = 'Too many requests. Please try again later.'): void {
  response.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  response.status(429).json({ message });
}

/**
 * Express middleware. `keyFn` returns the bucket key (e.g. user id) or null to skip.
 * Keys are namespaced by `scope` so endpoint budgets never collide.
 */
export function rateLimitMiddleware(
  scope: string,
  config: RateLimitConfig,
  keyFn: (request: Request) => string | null | undefined,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const key = keyFn(request);
    if (!key) {
      next();
      return;
    }
    const result = checkRateLimit(`${scope}:${key}`, config);
    if (!result.allowed) {
      sendRateLimited(response, result.retryAfterMs);
      return;
    }
    next();
  };
}

export const byUser = (request: Request) => request.auth?.id;
export const byIp = (request: Request) => request.ip || request.socket.remoteAddress || 'unknown';

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const rateLimits = {
  userCreate: { windowMs: 60 * 60_000, maxAttempts: 20, lockoutMs: 30 * 60_000 },
  storeCreate: { windowMs: 60 * 60_000, maxAttempts: 10, lockoutMs: 30 * 60_000 },
  passwordChange: { windowMs: 15 * 60_000, maxAttempts: 5, lockoutMs: 30 * 60_000 },
  sessionExtend: { windowMs: 5 * 60_000, maxAttempts: 10, lockoutMs: 5 * 60_000 },
  // Failure counters: lock after N failed logins inside the window.
  loginAccountFailures: { windowMs: 15 * 60_000, maxAttempts: 5, lockoutMs: 15 * 60_000 },
  loginIpFailures: { windowMs: 15 * 60_000, maxAttempts: 30, lockoutMs: 15 * 60_000 },
  // Total login attempts per IP (successful or not), generous enough for a shared store network.
  loginIpAttempts: { windowMs: 15 * 60_000, maxAttempts: 100, lockoutMs: 15 * 60_000 },
  logout: { windowMs: 60_000, maxAttempts: 20, lockoutMs: 60_000 },
  apiIp: { windowMs: 60_000, maxAttempts: positiveIntEnv('API_RATE_LIMIT_PER_MINUTE', 600), lockoutMs: 60_000 },
  expensiveRead: { windowMs: 60_000, maxAttempts: positiveIntEnv('EXPENSIVE_RATE_LIMIT_PER_MINUTE', 60), lockoutMs: 60_000 },
  upload: { windowMs: 10 * 60_000, maxAttempts: 30, lockoutMs: 10 * 60_000 },
  write: { windowMs: 60_000, maxAttempts: 120, lockoutMs: 60_000 },
} satisfies Record<string, RateLimitConfig>;
