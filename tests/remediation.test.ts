import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Franchise } from '../src/models/Franchise.js';
import { InventoryItem } from '../src/models/Inventory.js';
import { User } from '../src/models/User.js';
import { contentDisposition, sanitizeFileName } from '../src/routes/franchise-employees.js';
import {
  checkRateLimit,
  MemoryRateLimitStore,
  rateLimits,
  recordRateLimitFailure,
  resetRateLimitsForTests,
} from '../src/utils/rateLimit.js';
import { signSessionToken } from '../src/utils/token.js';
import { queryResult, storeId, userId } from './helpers/franchiseApi.js';

const adminId = new mongoose.Types.ObjectId();
const targetId = new mongoose.Types.ObjectId();
const api = { url: '' };
let server: Server;
const previousSecret = process.env.JWT_SECRET;

type Actor = Record<string, unknown> & { _id: mongoose.Types.ObjectId; role: string };
let actor: Actor;
let target: Record<string, unknown> | null;

const admin = (): Actor => ({ _id: adminId, name: 'Admin', email: 'admin@example.test', role: 'admin', sessionVersion: 0, isActive: true, franchises: [] });
const franchiseAdmin = (extra: Record<string, unknown> = {}): Actor => ({
  _id: userId, name: 'Owner', email: 'owner@example.test', role: 'franchise_admin',
  sessionVersion: 0, isActive: true, franchises: [storeId], password: 'stored-hash', ...extra,
});

before(async () => {
  process.env.JWT_SECRET = 'unit-test-only-not-a-production-secret';
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
  actor = admin();
  target = null;
  mock.method(User, 'findById', (id: unknown) => queryResult(String(id) === String(actor._id) ? actor : target));
  mock.method(Franchise, 'find', () => queryResult([{ _id: storeId }]));
});
afterEach(() => mock.restoreAll());

async function call(method: string, path: string, body?: unknown) {
  const token = await signSessionToken({ id: String(actor._id), name: String(actor.name), email: String(actor.email), role: actor.role as never });
  return fetch(`${api.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function captureAudit() {
  const events: Array<Record<string, unknown>> = [];
  const original = console.log;
  mock.method(console, 'log', (...args: unknown[]) => {
    const line = String(args[0]);
    if (line.startsWith('[AUDIT] ')) events.push(JSON.parse(line.slice(8)));
    else original(...args);
  });
  return events;
}

describe('R1 — admin user creation and role-change validation', () => {
  const valid = { name: 'New Owner', email: 'new@example.test', password: 'Valid-Passw0rd!', role: 'franchise_admin', franchiseIds: [String(storeId)] };

  it('rejects disallowed roles, bad store counts and unknown stores', async () => {
    mock.method(Franchise, 'countDocuments', async () => 0);
    assert.equal((await call('POST', '/users', { ...valid, role: 'admin' })).status, 403);
    assert.equal((await call('POST', '/users', { ...valid, franchiseIds: [] })).status, 400);
    assert.equal((await call('POST', '/users', { name: 'E', role: 'employee', franchiseIds: [] })).status, 400);
    assert.equal((await call('POST', '/users', { name: 'E', role: 'employee', franchiseIds: [String(storeId), String(new mongoose.Types.ObjectId())] })).status, 400);
    assert.equal((await call('POST', '/users', { ...valid, franchiseIds: ['not-an-id'] })).status, 400);
    const unknownStore = await call('POST', '/users', valid);
    assert.equal(unknownStore.status, 400);
    assert.match((await unknownStore.json()).message, /do not exist/);
  });

  it('rejects duplicate emails with 409', async () => {
    mock.method(Franchise, 'countDocuments', async () => 1);
    mock.method(User, 'exists', async () => ({ _id: targetId }));
    const create = mock.method(User, 'create', async () => { throw new Error('must not create'); });
    assert.equal((await call('POST', '/users', valid)).status, 409);
    assert.equal(create.mock.callCount(), 0);
  });

  it('creates users with mustChangePassword=true and audits the creation', async () => {
    mock.method(Franchise, 'countDocuments', async () => 1);
    mock.method(User, 'exists', async () => null);
    const create = mock.method(User, 'create', async (doc: Record<string, unknown>) => ({ ...doc, _id: targetId }));
    const events = captureAudit();
    const response = await call('POST', '/users', valid);
    assert.equal(response.status, 201);
    const doc = create.mock.calls[0]?.arguments[0] as Record<string, unknown>;
    assert.equal(doc.mustChangePassword, true);
    assert.notEqual(doc.password, valid.password);
    assert.ok(events.some((event) => event.action === 'user.created' && event.targetId === String(targetId)));
    assert.ok(!JSON.stringify(events).includes(valid.password));
  });

  it('clears stale store assignments when a user is changed to sub_admin', async () => {
    const save = mock.fn(async () => undefined);
    target = { _id: targetId, name: 'T', email: 't@example.test', role: 'franchise_admin', franchises: [storeId], sessionVersion: 3, save };
    const response = await call('PATCH', `/users/${targetId}`, { role: 'sub_admin' });
    assert.equal(response.status, 200);
    assert.equal(save.mock.callCount(), 1);
    assert.deepEqual(target.franchises, []);
    assert.equal(target.role, 'sub_admin');
    assert.equal(target.sessionVersion, 4);
  });
});

describe('R2/R3 — forced password change and accurate audit actions', () => {
  it('blocks every non-allowlisted API for a flagged user with PASSWORD_CHANGE_REQUIRED', async () => {
    actor = franchiseAdmin({ mustChangePassword: true });
    for (const [method, path] of [['GET', `/inventory?storeId=${storeId}`], ['GET', '/stores'], ['POST', '/users'], ['GET', `/dashboard?storeId=${storeId}`]]) {
      const response = await call(method, path, method === 'POST' ? {} : undefined);
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal((await response.json()).code, 'PASSWORD_CHANGE_REQUIRED');
    }
    const me = await call('GET', '/me');
    assert.notEqual(me.status, 403);
  });

  it('rejects reusing the issued password and wrong current passwords', async () => {
    actor = franchiseAdmin({ mustChangePassword: true, save: mock.fn(async () => undefined) });
    mock.method(bcrypt, 'compare', async () => true);
    const reuse = await call('PATCH', '/me', { currentPassword: 'Issued-Passw0rd!', newPassword: 'Issued-Passw0rd!' });
    assert.equal(reuse.status, 400);
    assert.equal(actor.mustChangePassword, true);

    mock.restoreAll();
    mock.method(User, 'findById', () => queryResult(actor));
    mock.method(bcrypt, 'compare', async () => false);
    const wrong = await call('PATCH', '/me', { currentPassword: 'wrong', newPassword: 'Brand-New-Passw0rd!' });
    assert.equal(wrong.status, 400);
    assert.equal(actor.mustChangePassword, true);
  });

  it('clears the flag, rotates the session and audits user.password.changed', async () => {
    const save = mock.fn(async () => undefined);
    actor = franchiseAdmin({ mustChangePassword: true, save });
    let compareCalls = 0;
    // First compare: current password matches. Second: new password differs from the issued one.
    mock.method(bcrypt, 'compare', async () => (compareCalls += 1) === 1);
    const events = captureAudit();
    const response = await call('PATCH', '/me', { currentPassword: 'Issued-Passw0rd!', newPassword: 'Brand-New-Passw0rd!' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mustChangePassword, false);
    assert.equal(typeof body.token, 'string');
    assert.equal(save.mock.callCount(), 1);
    assert.equal(actor.mustChangePassword, false);
    assert.equal(actor.sessionVersion, 1);
    assert.ok(events.some((event) => event.action === 'user.password.changed'));
    assert.ok(!JSON.stringify(events).includes('Brand-New-Passw0rd!'));
  });

  it('audits a name-only edit as user.profile.updated, not password.changed', async () => {
    actor = franchiseAdmin({ save: mock.fn(async () => undefined) });
    const events = captureAudit();
    assert.equal((await call('PATCH', '/me', { name: 'Renamed' })).status, 200);
    assert.ok(events.some((event) => event.action === 'user.profile.updated'));
    assert.ok(!events.some((event) => event.action === 'user.password.changed'));
  });

  it('returns mustChangePassword from login', async () => {
    const findOne = mock.fn(async () => ({ _id: userId, name: 'Owner', email: 'owner@example.test', role: 'franchise_admin', password: 'hash', franchises: [storeId], sessionVersion: 0, mustChangePassword: true }));
    mock.method(mongoose.connection, 'collection', () => ({ findOne }));
    mock.method(bcrypt, 'compare', async () => true);
    const response = await fetch(`${api.url}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'Issued-Passw0rd!' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.mustChangePassword, true);
  });
});

describe('R5 — FIFO consumption race is compensated', () => {
  it('reverts the decrement and returns 409 when an earlier batch appears mid-request', async () => {
    actor = franchiseAdmin();
    const itemId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const earlier = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    let earlierLookups = 0;
    mock.method(InventoryItem, 'findOne', (query: Record<string, unknown>) => {
      if (query._id) return queryResult({ _id: itemId, productId, product: 'Milk', quantity: 5, expiryDate: later });
      earlierLookups += 1;
      // Pre-check sees no earlier batch; the post-update re-check sees a concurrently restocked one.
      return queryResult(earlierLookups === 1 ? null : { _id: new mongoose.Types.ObjectId(), quantity: 3, expiryDate: earlier });
    });
    mock.method(InventoryItem, 'findOneAndUpdate', async () => ({ _id: itemId, productId, product: 'Milk', quantity: 3, expiryDate: later }));
    const revert = mock.method(InventoryItem, 'updateOne', async () => ({ modifiedCount: 1 }));
    const events = captureAudit();
    const response = await call('PATCH', `/inventory?storeId=${storeId}`, { action: 'consume', inventoryItemId: String(itemId), quantity: 2 });
    assert.equal(response.status, 409);
    assert.equal(revert.mock.callCount(), 1);
    const [filter, update] = revert.mock.calls[0]!.arguments as unknown as [Record<string, unknown>, { $inc: { quantity: number } }];
    assert.equal(String(filter._id), String(itemId));
    assert.equal(update.$inc.quantity, 2);
    assert.ok(!events.some((event) => event.action === 'inventory.stock.consumed'));
  });
});

describe('R6 — document filename length and header safety', () => {
  it('caps filenames at 100 characters and strips header metacharacters', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    assert.equal(sanitizeFileName(long).length, 100);
    assert.equal(sanitizeFileName('../../etc/"evil"\r\nSet-Cookie: x;.pdf'), 'evilSet-Cookie x.pdf');
    const header = contentDisposition(`${'é'.repeat(255)}"\r\n`);
    assert.ok(!/[\r\n]/.test(header));
    assert.ok(header.length < 1200);
  });
});

describe('R7 — admin store list redacts operational fields', () => {
  it('selects only identity/owner fields, never shifts, salary or logo blobs', async () => {
    let selected = '';
    mock.method(Franchise, 'find', () => {
      const chain = queryResult([]) as unknown as { select: (fields: string) => unknown };
      const originalSelect = chain.select.bind(chain);
      chain.select = (fields: string) => { selected = fields; return originalSelect(fields); };
      return chain;
    });
    mock.method(Franchise, 'countDocuments', async () => 0);
    assert.equal((await call('GET', '/stores')).status, 200);
    assert.ok(selected.includes('name'));
    for (const field of ['shifts', 'positions', 'salary', 'logo', 'password']) {
      assert.ok(!selected.toLowerCase().includes(field), `must not select ${field}`);
    }
  });
});

describe('R8 — bounded in-memory rate-limit store', () => {
  it('stays within its cap under a key flood, quickly, and keeps active lockouts', () => {
    const store = new MemoryRateLimitStore(1000);
    const now = Date.now();
    store.set('locked-victim', { count: 99, firstAt: now, lockedUntil: now + 60_000 });
    const started = performance.now();
    for (let index = 0; index < 50_000; index += 1) store.set(`flood:${index}`, { count: 1, firstAt: now });
    assert.ok(performance.now() - started < 2000, 'flood must not be quadratic');
    assert.ok(store.size() <= 1000);
    assert.ok(store.get('locked-victim'), 'an active lockout must survive pruning');
  });
});

describe('R9 — login lockout is per (account, IP) with a global account ceiling', () => {
  const victim = 'victim@example.test';
  const login = () => fetch(`${api.url}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: victim, password: 'wrong-password' }),
  });

  beforeEach(() => {
    const findOne = mock.fn(async () => ({ _id: targetId, name: 'V', email: victim, role: 'admin', password: 'hash', franchises: [], sessionVersion: 0 }));
    mock.method(mongoose.connection, 'collection', () => ({ findOne }));
    mock.method(bcrypt, 'compare', async () => false);
  });

  it('a lockout from another IP does not lock the victim out from their own IP', async () => {
    for (let index = 0; index < rateLimits.loginAccountFailures.maxAttempts + 2; index += 1) {
      recordRateLimitFailure(`login-account-ip-failures:${victim}:203.0.113.9`, rateLimits.loginAccountFailures);
    }
    assert.equal((await login()).status, 401);
  });

  it('the global per-account ceiling still stops distributed guessing', async () => {
    for (let index = 0; index < rateLimits.loginAccountGlobalFailures.maxAttempts; index += 1) {
      recordRateLimitFailure(`login-account-failures:${victim}`, rateLimits.loginAccountGlobalFailures);
    }
    assert.equal((await login()).status, 429);
  });

  it('the generic limiter remains independent of the login keys', () => {
    assert.equal(checkRateLimit('unrelated', rateLimits.write).allowed, true);
  });
});
