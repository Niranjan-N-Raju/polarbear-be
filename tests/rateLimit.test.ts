import assert from 'node:assert/strict';
import { mock, describe, it } from 'node:test';
import { checkRateLimit, rateLimits } from '../src/utils/rateLimit.js';

describe('checkRateLimit', () => {
  it('allows attempts up to the configured limit and then locks the key', () => {
    const key = `rate-limit-${crypto.randomUUID()}`;
    let now = 1_000;
    const dateNow = mock.method(Date, 'now', () => now);

    try {
      const config = { windowMs: 60_000, maxAttempts: 2, lockoutMs: 30_000 };
      assert.deepEqual(checkRateLimit(key, config), { allowed: true });
      assert.deepEqual(checkRateLimit(key, config), { allowed: true });
      assert.deepEqual(checkRateLimit(key, config), { allowed: false, retryAfterMs: 30_000 });

      now += 5_000;
      assert.deepEqual(checkRateLimit(key, config), { allowed: false, retryAfterMs: 25_000 });
    } finally {
      dateNow.mock.restore();
    }
  });

  it('starts a fresh window after the lockout expires', () => {
    const key = `rate-limit-${crypto.randomUUID()}`;
    let now = 10_000;
    const dateNow = mock.method(Date, 'now', () => now);

    try {
      const config = { windowMs: 60_000, maxAttempts: 1, lockoutMs: 5_000 };
      assert.deepEqual(checkRateLimit(key, config), { allowed: true });
      assert.deepEqual(checkRateLimit(key, config), { allowed: false, retryAfterMs: 5_000 });

      now += 5_000;
      assert.deepEqual(checkRateLimit(key, config), { allowed: true });
    } finally {
      dateNow.mock.restore();
    }
  });

  it('exposes the configured limits for protected actions', () => {
    assert.equal(rateLimits.userCreate.maxAttempts, 20);
    assert.equal(rateLimits.storeCreate.maxAttempts, 10);
    assert.equal(rateLimits.passwordChange.maxAttempts, 5);
    assert.equal(rateLimits.sessionExtend.maxAttempts, 10);
  });
});
