import type { NextFunction, Request, Response } from 'express';

export interface RateLimitEntry {
  count: number;
  firstAt: number;
  lockedUntil?: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxAttempts: number;
  lockoutMs: number;
}

/**
 * Storage backend for rate-limit counters. The default is process-local memory, so each API
 * instance enforces its own budget. A multi-instance deployment must either install a shared
 * store via `setRateLimitStore()` (e.g. a Redis-backed adapter that keeps a synchronous local
 * cache) or enforce limits at the edge/WAF. See INDEPENDENT-SECURITY-REVIEW.md (R8).
 */
export interface RateLimitStore {
  get(key: string): RateLimitEntry | undefined;
  set(key: string, entry: RateLimitEntry): void;
  delete(key: string): void;
  clear(): void;
  size(): number;
}

const MAX_ENTRIES = 10_000;
const MAX_ENTRY_AGE_MS = 2 * 60 * 60_000;

/** Bounded in-memory store; evicts stale/unlocked entries first so a key flood cannot lift lockouts. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, RateLimitEntry>();

  constructor(private readonly maxEntries = MAX_ENTRIES) {}

  get(key: string): RateLimitEntry | undefined {
    return this.map.get(key);
  }

  set(key: string, entry: RateLimitEntry): void {
    if (!this.map.has(key) && this.map.size >= this.maxEntries) this.prune(Date.now());
    this.map.set(key, entry);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  // Prunes down to a low-water mark (not just one slot) so a key flood costs amortized O(1)
  // per insert instead of a full scan on every insert.
  private prune(now: number): void {
    const target = Math.floor(this.maxEntries * 0.9);
    const unlocked = (entry: RateLimitEntry) => !entry.lockedUntil || now >= entry.lockedUntil;
    for (const [key, entry] of this.map) {
      if (now - entry.firstAt > MAX_ENTRY_AGE_MS && unlocked(entry)) this.map.delete(key);
    }
    for (const [key, entry] of this.map) {
      if (this.map.size <= target) return;
      if (unlocked(entry)) this.map.delete(key);
    }
    for (const key of this.map.keys()) {
      if (this.map.size <= target) return;
      this.map.delete(key);
    }
  }
}

let store: RateLimitStore = new MemoryRateLimitStore();

/** Replaces the counter backend (call once at startup, before serving traffic). */
export function setRateLimitStore(next: RateLimitStore): void {
  store = next;
}

export function getRateLimitStore(): RateLimitStore {
  return store;
}

export function rateLimitEntryCount(): number {
  return store.size();
}

export function resetRateLimit(key: string): void {
  store.delete(key);
}

export function resetRateLimitsForTests(): void {
  store.clear();
}

function freshEntry(current: RateLimitEntry | undefined, now: number, config: RateLimitConfig): boolean {
  return !current || now - current.firstAt > config.windowMs || (current.lockedUntil !== undefined && now >= current.lockedUntil);
}

export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const current = store.get(key);

  if (current?.lockedUntil && now < current.lockedUntil) {
    return { allowed: false, retryAfterMs: current.lockedUntil - now };
  }

  if (freshEntry(current, now, config)) {
    store.set(key, { count: 1, firstAt: now });
    return { allowed: true };
  }

  const next: RateLimitEntry = { ...current!, count: current!.count + 1 };
  if (next.count > config.maxAttempts) {
    next.lockedUntil = now + config.lockoutMs;
    store.set(key, next);
    return { allowed: false, retryAfterMs: config.lockoutMs };
  }
  store.set(key, next);
  return { allowed: true };
}

/** Reports an active lockout without consuming budget (used for failure-only counters). */
export function peekRateLimit(key: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const current = store.get(key);
  if (current?.lockedUntil && now < current.lockedUntil) {
    return { allowed: false, retryAfterMs: current.lockedUntil - now };
  }
  return { allowed: true };
}

/** Records one failure; the key locks once `maxAttempts` failures occur inside the window. */
export function recordRateLimitFailure(key: string, config: RateLimitConfig): void {
  const now = Date.now();
  const current = store.get(key);
  if (current?.lockedUntil && now < current.lockedUntil) return;
  const base = freshEntry(current, now, config) ? { count: 0, firstAt: now } : current!;
  const count = base.count + 1;
  store.set(key, {
    count,
    firstAt: base.firstAt,
    lockedUntil: count >= config.maxAttempts ? now + config.lockoutMs : undefined,
  });
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
  // Per (account, IP): tight, so one source cannot brute-force an account...
  loginAccountFailures: { windowMs: 15 * 60_000, maxAttempts: 5, lockoutMs: 15 * 60_000 },
  // ...per account across all IPs: much higher, so an attacker cannot lock a victim out
  // with a handful of bad guesses, but distributed guessing is still capped.
  loginAccountGlobalFailures: { windowMs: 15 * 60_000, maxAttempts: 50, lockoutMs: 15 * 60_000 },
  loginIpFailures: { windowMs: 15 * 60_000, maxAttempts: 30, lockoutMs: 15 * 60_000 },
  // Total login attempts per IP (successful or not), generous enough for a shared store network.
  loginIpAttempts: { windowMs: 15 * 60_000, maxAttempts: 100, lockoutMs: 15 * 60_000 },
  logout: { windowMs: 60_000, maxAttempts: 20, lockoutMs: 60_000 },
  apiIp: { windowMs: 60_000, maxAttempts: positiveIntEnv('API_RATE_LIMIT_PER_MINUTE', 600), lockoutMs: 60_000 },
  expensiveRead: { windowMs: 60_000, maxAttempts: positiveIntEnv('EXPENSIVE_RATE_LIMIT_PER_MINUTE', 60), lockoutMs: 60_000 },
  upload: { windowMs: 10 * 60_000, maxAttempts: 30, lockoutMs: 10 * 60_000 },
  write: { windowMs: 60_000, maxAttempts: 120, lockoutMs: 60_000 },
} satisfies Record<string, RateLimitConfig>;
