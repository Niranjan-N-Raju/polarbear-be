import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Franchise } from '../src/models/Franchise.js';
import { User } from '../src/models/User.js';
import { configureServerTimeouts, SERVER_TIMEOUTS } from '../src/config/httpServer.js';
import { MAX_PRODUCTS_PER_REQUEST } from '../src/routes/franchise-inventory.js';
import { MAX_WITHDRAWAL_RESULTS } from '../src/routes/franchise-withdrawals.js';
import { clampPage, isSearchTooLong, MAX_PAGE, MAX_SEARCH_LENGTH } from '../src/utils/listQuery.js';
import { checkRateLimit, rateLimits, resetRateLimitsForTests } from '../src/utils/rateLimit.js';
import { signSessionToken } from '../src/utils/token.js';
import { otherStoreId, queryResult, storeId, userId } from './helpers/franchiseApi.js';

const api = { url: '', token: '' };
let server: Server;
const previousSecret = process.env.JWT_SECRET;

before(async () => {
  process.env.JWT_SECRET = 'unit-test-only-not-a-production-secret';
  api.token = await signSessionToken({ id: String(userId), name: 'Test', email: 'test@example.test', role: 'franchise_admin' });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  api.url = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

beforeEach(() => {
  resetRateLimitsForTests();
  // Echo the token's user id so per-user limiter buckets differ between users.
  mock.method(User, 'findById', (id: unknown) => queryResult({
    _id: id, name: 'Test', email: 'test@example.test', role: 'franchise_admin',
    sessionVersion: 0, isActive: true, franchises: [storeId],
  }));
  mock.method(Franchise, 'find', () => queryResult([{ _id: storeId }]));
});
afterEach(() => mock.restoreAll());

const validUser = {
  _id: new mongoose.Types.ObjectId(), name: 'Admin', email: 'admin@example.test',
  role: 'admin', password: 'stored-hash', sessionVersion: 0, franchises: [],
};

function mockUsers(lookup: (filter: { email: string }) => unknown) {
  const findOne = mock.fn(async (filter: { email: string }) => lookup(filter));
  mock.method(mongoose.connection, 'collection', () => ({ findOne }));
  return findOne;
}

function login(email: string, password = 'wrong-password', headers: Record<string, string> = {}) {
  return fetch(`${api.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email, password }),
  });
}

function get(path: string, token = api.token, headers: Record<string, string> = {}) {
  return fetch(`${api.url}${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
}

describe('login brute-force protection', () => {
  it('locks an account after 5 failures with Retry-After, without touching other accounts', async () => {
    mock.method(bcrypt, 'compare', async () => false);
    mockUsers(() => validUser);
    for (let attempt = 0; attempt < rateLimits.loginAccountFailures.maxAttempts; attempt += 1) {
      assert.equal((await login('victim@example.test')).status, 401);
    }
    const locked = await login('VICTIM@example.test ');
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal((await login('someone-else@example.test')).status, 401);
  });

  it('throttles one IP spraying many accounts, and a spoofed X-Forwarded-For does not escape it', async () => {
    mock.method(bcrypt, 'compare', async () => false);
    mockUsers(() => null);
    for (let attempt = 0; attempt < rateLimits.loginIpFailures.maxAttempts; attempt += 1) {
      assert.equal((await login(`spray-${attempt}@example.test`)).status, 401);
    }
    const blocked = await login('fresh@example.test', 'pw', { 'X-Forwarded-For': '203.0.113.77' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });

  it('does not let a successful login reset the per-IP failure budget', async () => {
    mock.method(bcrypt, 'compare', async (password: string) => password === 'correct-password');
    mockUsers(() => validUser);
    const failures = rateLimits.loginIpFailures.maxAttempts;
    for (let attempt = 0; attempt < failures - 1; attempt += 1) {
      assert.equal((await login(`guess-${attempt}@example.test`)).status, 401);
    }
    assert.equal((await login('admin@example.test', 'correct-password')).status, 200);
    assert.equal((await login('guess-final@example.test')).status, 401);
    assert.equal((await login('admin@example.test', 'correct-password')).status, 429);
  });

  it('runs a bcrypt comparison even for unknown accounts (no timing oracle)', async () => {
    const compare = mock.method(bcrypt, 'compare', async () => false);
    mockUsers(() => null);
    assert.equal((await login('nobody@example.test')).status, 401);
    assert.equal(compare.mock.callCount(), 1);
    assert.equal(typeof compare.mock.calls[0]?.arguments[1], 'string');
  });

  it('rejects oversized credentials before any database lookup', async () => {
    const findOne = mockUsers(() => validUser);
    assert.equal((await login('a@example.test', 'x'.repeat(201))).status, 400);
    assert.equal((await login(`${'a'.repeat(250)}@example.test`)).status, 400);
    assert.equal(findOne.mock.callCount(), 0);
  });
});

describe('request size and global limits', () => {
  it('returns 413 for a JSON body above the 1 MB limit', async () => {
    const response = await fetch(`${api.url}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(1_100_000) }),
    });
    assert.equal(response.status, 413);
  });

  it('applies the per-IP API ceiling but never throttles health probes', async () => {
    for (let index = 0; index < rateLimits.apiIp.maxAttempts; index += 1) {
      checkRateLimit('api-ip:127.0.0.1', rateLimits.apiIp);
    }
    const health = await fetch(`${api.url}/health`);
    assert.notEqual(health.status, 429);
    const blocked = await get('/does-not-exist', api.token, { 'X-Forwarded-For': '198.51.100.9' });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
  });

  it('configures HTTP server timeouts against slow-client exhaustion', () => {
    const server = configureServerTimeouts(createServer());
    assert.equal(server.headersTimeout, SERVER_TIMEOUTS.headersTimeoutMs);
    assert.equal(server.requestTimeout, SERVER_TIMEOUTS.requestTimeoutMs);
    assert.equal(server.keepAliveTimeout, SERVER_TIMEOUTS.keepAliveTimeoutMs);
    assert.equal(server.maxRequestsPerSocket, SERVER_TIMEOUTS.maxRequestsPerSocket);
    assert.ok(server.headersTimeout <= server.requestTimeout);
  });
});

describe('per-user endpoint budgets', () => {
  it('throttles expensive report reads per user without affecting other users', async () => {
    const path = `/pnl?storeId=${otherStoreId}`;
    for (let index = 0; index < rateLimits.expensiveRead.maxAttempts; index += 1) {
      assert.equal((await get(path)).status, 403);
    }
    const blocked = await get(path);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    const otherToken = await signSessionToken({
      id: String(new mongoose.Types.ObjectId()), name: 'Other', email: 'other@example.test', role: 'franchise_admin',
    });
    assert.notEqual((await get(path, otherToken)).status, 429);
  });

  it('throttles upload endpoints per user', async () => {
    const path = `/stores/logo?storeId=${otherStoreId}`;
    for (let index = 0; index < rateLimits.upload.maxAttempts; index += 1) {
      assert.notEqual((await get(path)).status, 429);
    }
    assert.equal((await get(path)).status, 429);
  });

  it('throttles session extension per user', async () => {
    mockUsers(() => null);
    for (let index = 0; index < rateLimits.sessionExtend.maxAttempts; index += 1) {
      await fetch(`${api.url}/auth/extend`, { method: 'POST', headers: { Authorization: `Bearer ${api.token}` } });
    }
    const blocked = await fetch(`${api.url}/auth/extend`, { method: 'POST', headers: { Authorization: `Bearer ${api.token}` } });
    assert.equal(blocked.status, 429);
  });
});

describe('query bounds', () => {
  it('rejects one-sided, reversed, and over-long withdrawal ranges after the store check', async () => {
    const base = `/withdrawals?storeId=${storeId}`;
    assert.equal((await get(`${base}&from=2025-01-01`)).status, 400);
    assert.equal((await get(`${base}&from=2025-02-01&to=2025-01-01`)).status, 400);
    assert.equal((await get(`${base}&from=2023-01-01&to=2025-01-01`)).status, 400);
    assert.equal((await get(`${base}&from=not-a-date&to=2025-01-01`)).status, 400);
    assert.equal((await get(`/withdrawals?storeId=${otherStoreId}&from=2025-01-01`)).status, 403);
    assert.equal(MAX_WITHDRAWAL_RESULTS, 1000);
  });

  it('rejects over-long search terms before building a regex', async () => {
    const response = await get(`/users?storeId=${storeId}&search=${'a'.repeat(MAX_SEARCH_LENGTH + 1)}`);
    assert.equal(response.status, 400);
    assert.equal(isSearchTooLong('a'.repeat(MAX_SEARCH_LENGTH)), false);
    assert.equal(isSearchTooLong(`  ${'a'.repeat(MAX_SEARCH_LENGTH)}  `), false);
    assert.equal(isSearchTooLong(undefined), false);
  });

  it('clamps deep pagination offsets', () => {
    assert.equal(clampPage(5), 5);
    assert.equal(clampPage(MAX_PAGE + 1), MAX_PAGE);
    assert.equal(clampPage(Number.MAX_SAFE_INTEGER), MAX_PAGE);
  });

  it('caps bulk product creation', () => {
    assert.equal(MAX_PRODUCTS_PER_REQUEST, 100);
  });
});

