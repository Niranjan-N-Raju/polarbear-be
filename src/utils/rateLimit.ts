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