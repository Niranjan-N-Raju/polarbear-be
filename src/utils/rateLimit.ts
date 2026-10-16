interface RateLimitEntry {
  count: number;
  firstAt: number;
  lockedUntil?: number;
}

interface RateLimitConfig {
  windowMs: number;
  maxAttempts: number;
  lockoutMs: number;
}

const entries = new Map<string, RateLimitEntry>();

export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const current = entries.get(key);

  if (current?.lockedUntil && now < current.lockedUntil) {
    return { allowed: false, retryAfterMs: current.lockedUntil - now };
  }

  if (!current || now - current.firstAt > config.windowMs || (current.lockedUntil && now >= current.lockedUntil)) {
    entries.set(key, { count: 1, firstAt: now });
    return { allowed: true };
  }

  current.count += 1;
  if (current.count > config.maxAttempts) {
    current.lockedUntil = now + config.lockoutMs;
    return { allowed: false, retryAfterMs: config.lockoutMs };
  }

  return { allowed: true };
}

export const rateLimits = {
  userCreate: { windowMs: 60 * 60_000, maxAttempts: 20, lockoutMs: 30 * 60_000 },
  storeCreate: { windowMs: 60 * 60_000, maxAttempts: 10, lockoutMs: 30 * 60_000 },
  passwordChange: { windowMs: 15 * 60_000, maxAttempts: 5, lockoutMs: 30 * 60_000 },
  sessionExtend: { windowMs: 5 * 60_000, maxAttempts: 10, lockoutMs: 5 * 60_000 },
} satisfies Record<string, RateLimitConfig>;