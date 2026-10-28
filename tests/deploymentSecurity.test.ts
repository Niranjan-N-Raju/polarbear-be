import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { after, afterEach, before, describe, it } from 'node:test';
import express from 'express';
import { app } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { allowedOrigins, configureTrustProxy } from '../src/middleware/securityHeaders.js';
import { checkRateLimit, rateLimitEntryCount } from '../src/utils/rateLimit.js';
import { signSessionToken } from '../src/utils/token.js';

const ENV_KEYS = ['NODE_ENV', 'WEB_ORIGINS', 'TRUST_PROXY', 'JWT_SECRET', 'MONGODB_URI', 'MONGODB_DB', 'FIELD_ENCRYPTION_KEY', 'PORT'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

let server: Server;
let baseUrl = '';

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  restoreEnv();
  server.close();
  await once(server, 'close');
});

afterEach(restoreEnv);

describe('security headers', () => {
  it('sets defensive headers on every response, including 404s', async () => {
    delete process.env.NODE_ENV;
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('strict-transport-security'), null);
  });

  it('adds HSTS only in production', async () => {
    process.env.NODE_ENV = 'production';
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=31536000/);
  });
});

describe('CORS', () => {
  it('reflects only allowlisted origins and always varies on Origin', async () => {
    process.env.WEB_ORIGINS = 'https://app.example.test';
    const allowed = await fetch(`${baseUrl}/api/does-not-exist`, { headers: { Origin: 'https://app.example.test' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');
    assert.match(allowed.headers.get('vary') ?? '', /Origin/);

    const denied = await fetch(`${baseUrl}/api/does-not-exist`, { headers: { Origin: 'https://evil.example.test' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.match(denied.headers.get('vary') ?? '', /Origin/);
  });

  it('answers preflight with 204 without granting unknown origins', async () => {
    process.env.WEB_ORIGINS = 'https://app.example.test';
    const response = await fetch(`${baseUrl}/api/auth/login`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example.test' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('ignores wildcard entries and never falls back to localhost in production', () => {
    process.env.WEB_ORIGINS = '*, https://app.example.test ,';
    assert.deepEqual(allowedOrigins(), ['https://app.example.test']);

    delete process.env.WEB_ORIGINS;
    process.env.NODE_ENV = 'production';
    assert.deepEqual(allowedOrigins(), []);

    process.env.NODE_ENV = 'development';
    assert.ok(allowedOrigins().includes('http://localhost:5173'));
  });
});

describe('trust proxy', () => {
  it('is disabled by default so X-Forwarded-For cannot spoof the client IP', () => {
    const target = express();
    delete process.env.TRUST_PROXY;
    configureTrustProxy(target);
    assert.equal(target.get('trust proxy'), false);
  });

  it('accepts only an explicit hop count', () => {
    const target = express();
    process.env.TRUST_PROXY = '1';
    configureTrustProxy(target);
    assert.equal(target.get('trust proxy'), 1);

    for (const value of ['true', '*', '-1', '11', 'loopback', '1.5']) {
      process.env.TRUST_PROXY = value;
      assert.throws(() => configureTrustProxy(express()), /TRUST_PROXY/);
    }
  });

  it('does not trust X-Forwarded-For in the default app', async () => {
    assert.equal(app.get('trust proxy'), false);
  });
});

describe('request body handling', () => {
  it('returns 400 (not 500) for malformed JSON without echoing parser details', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": ',
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { message: string; stack?: string };
    assert.equal(body.message, 'Invalid request body.');
    assert.equal(body.stack, undefined);
  });

  it('caps ordinary JSON bodies at 1 MB with a 413', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(1_100_000) }),
    });
    assert.equal(response.status, 413);
  });

  it('still lets upload endpoints receive multi-megabyte base64 bodies (reaching auth instead of 413)', async () => {
    const response = await fetch(`${baseUrl}/api/stores/logo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: 'A'.repeat(2_500_000) }),
    });
    assert.equal(response.status, 401);
  });

  it('rejects upload bodies above the 8 MB ceiling', async () => {
    const response = await fetch(`${baseUrl}/api/stores/logo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: 'A'.repeat(8_500_000) }),
    });
    assert.equal(response.status, 413);
  });
});

describe('configuration validation', () => {
  function baseEnv() {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/never-connected';
    process.env.MONGODB_DB = 'test';
    process.env.JWT_SECRET = 'deployment-tests-only-not-a-production-secret';
    process.env.PORT = '4000';
    delete process.env.NODE_ENV;
  }

  it('rejects a short JWT_SECRET at startup, signing and verification', async () => {
    baseEnv();
    process.env.JWT_SECRET = 'too-short-secret';
    assert.throws(() => loadConfig(), /at least 32 characters/);
    await assert.rejects(
      signSessionToken({ id: '507f1f77bcf86cd799439011', name: 'T', email: 't@example.test', role: 'franchise_admin' }),
      /at least 32 characters/,
    );
    const response = await fetch(`${baseUrl}/api/stores/logo`, { method: 'POST', headers: { Authorization: 'Bearer a.b.c' } });
    assert.equal(response.status, 401);
  });

  it('allows native-only production configuration and requires FIELD_ENCRYPTION_KEY', () => {
    baseEnv();
    process.env.NODE_ENV = 'production';
    delete process.env.WEB_ORIGINS;
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    assert.equal(loadConfig().mongoDatabase, 'test');
    process.env.FIELD_ENCRYPTION_KEY = '';
    assert.throws(() => loadConfig(), /FIELD_ENCRYPTION_KEY/);
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    assert.deepEqual(allowedOrigins(), []);
    process.env.WEB_ORIGINS = '   ';
    assert.equal(loadConfig().mongoDatabase, 'test');
    assert.deepEqual(allowedOrigins(), []);

    process.env.WEB_ORIGINS = 'https://app.example.test';
    process.env.FIELD_ENCRYPTION_KEY = 'not-hex';
    assert.throws(() => loadConfig(), /FIELD_ENCRYPTION_KEY/);

    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    assert.equal(loadConfig().mongoDatabase, 'test');
  });
});

describe('rate limiter memory bound', () => {
  it('stays bounded under a flood of unique keys without lifting active lockouts', () => {
    const config = { windowMs: 60_000, maxAttempts: 1, lockoutMs: 60_000 };
    const victim = `victim-${crypto.randomUUID()}`;
    assert.equal(checkRateLimit(victim, config).allowed, true);
    assert.equal(checkRateLimit(victim, config).allowed, false);
    for (let index = 0; index < 25_000; index += 1) checkRateLimit(`flood-${index}-${crypto.randomUUID()}`, config);
    assert.ok(rateLimitEntryCount() <= 10_001, `entries grew to ${rateLimitEntryCount()}`);
    assert.equal(checkRateLimit(victim, config).allowed, false);
  });
});
