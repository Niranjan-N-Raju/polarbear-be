import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Advance } from '../src/models/Advance.js';
import { Attendance } from '../src/models/Attendance.js';
import { Franchise } from '../src/models/Franchise.js';
import { User, type UserRole } from '../src/models/User.js';
import { WeeklyRoster } from '../src/models/WeeklyRoster.js';
import { findDangerousKey } from '../src/middleware/rejectDangerousKeys.js';
import { queryResult } from './helpers/franchiseApi.js';
import { signSessionToken } from '../src/utils/token.js';

const actorId = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();
const foreignStore = new mongoose.Types.ObjectId();
const recordId = new mongoose.Types.ObjectId();
const SENSITIVE_KEYS = ['password', 'sessionVersion', 'createdBy', '__v', 'fileId'];
let server: Server;
let baseUrl: string;
let token: string;
let role: UserRole;
const previousSecret = process.env.JWT_SECRET;

before(async () => {
  process.env.JWT_SECRET = 'database-security-tests-only-not-a-production-secret';
  token = await signSessionToken({ id: String(actorId), name: 'Test', email: 'db@example.test', role: 'admin' });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});
beforeEach(() => {
  role = 'franchise_admin';
  mock.method(User, 'findById', () => queryResult({
    _id: actorId, name: 'Test', email: 'db@example.test', role, isActive: true, franchises: [storeId], sessionVersion: 0,
  }));
  mock.method(Franchise, 'find', (filter: Record<string, unknown>) => {
    const ids = ((filter._id as { $in?: unknown[] } | undefined)?.$in ?? []).map(String);
    return queryResult(ids.includes(String(storeId)) ? [{ _id: storeId, name: 'Store', isActive: true }] : []);
  });
});
afterEach(() => mock.restoreAll());

async function call(method: string, path: string, body?: unknown, rawBody?: string) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}
function assertNoSensitiveKeys(value: unknown, path = 'response') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!SENSITIVE_KEYS.includes(key), `${path}.${key} must not be exposed`);
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}
function forbidQuery(model: object, method: string) {
  return mock.method(model as Record<string, () => unknown>, method, () => {
    throw new Error(`${method} must not run for rejected input`);
  });
}

describe('operator, dotted-path and prototype-pollution keys are rejected before any route', () => {
  it('detects dangerous keys at any depth and allows ordinary keys', () => {
    assert.equal(findDangerousKey({ email: 'a', values: { rent: 1, salesTarget: 2 }, items: [{ id: 1 }] }), null);
    assert.equal(findDangerousKey({ email: { $ne: null } }), '$ne');
    assert.equal(findDangerousKey({ values: { 'a.b': 1 } }), 'a.b');
    assert.equal(findDangerousKey(JSON.parse('{"x":[{"__proto__":{"isAdmin":true}}]}')), '__proto__');
    assert.equal(findDangerousKey({ a: { constructor: { prototype: {} } } }), 'constructor');
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 30; index += 1) { deep.next = {}; deep = deep.next as Record<string, unknown>; }
    assert.ok(findDangerousKey(root));
  });

  it('blocks NoSQL operator injection on login without querying users', async () => {
    const findOne = forbidQuery(User, 'findOne');
    for (const body of [{ email: { $ne: null }, password: 'x' }, { email: 'a@b.test', password: { $gt: '' } }]) {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    const arrayEmail = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ['a@b.test'], password: 'x' }),
    });
    assert.equal(arrayEmail.status, 400);
    assert.equal(findOne.mock.callCount(), 0);
  });

  for (const [label, rawBody] of [
    ['$set update operator', '{"type":"x","amount":1,"$set":{"franchise":"x"}}'],
    ['dotted path', '{"type":"x","amount":1,"franchise.0":"x"}'],
    ['__proto__', '{"type":"x","amount":1,"__proto__":{"franchise":"x"}}'],
    ['nested constructor', '{"type":"x","amount":1,"meta":{"constructor":{"prototype":{"admin":true}}}}'],
  ] as const) {
    it(`rejects ${label} in an authenticated write body`, async () => {
      const findOne = forbidQuery(Advance, 'findOne');
      const response = await call('PUT', `/advances/${recordId}?storeId=${storeId}`, undefined, rawBody);
      assert.equal(response.status, 400);
      assert.equal(findOne.mock.callCount(), 0);
    });
  }
});

describe('salary entry updates validate types exactly like creation', () => {
  for (const [label, body] of [
    ['string amount', { type: 'Advance', amount: '5' }],
    ['boolean amount', { type: 'Advance', amount: true }],
    ['array amount', { type: 'Advance', amount: [5] }],
    ['negative amount', { type: 'Advance', amount: -1 }],
    ['oversized type', { type: 'x'.repeat(101), amount: 5 }],
    ['non-string type', { type: { a: 1 }, amount: 5 }],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const findOne = forbidQuery(Advance, 'findOne');
      const response = await call('PUT', `/advances/${recordId}?storeId=${storeId}`, body);
      assert.equal(response.status, 400);
      assert.equal(findOne.mock.callCount(), 0);
    });
  }

  it('scopes the update lookup to the authorized store and 404s for a foreign record id', async () => {
    const findOne = mock.method(Advance, 'findOne', (filter: Record<string, unknown>) => {
      assert.equal(String(filter.franchise), String(storeId));
      return Promise.resolve(null);
    });
    const response = await call('PUT', `/advances/${recordId}?storeId=${storeId}`, { type: 'Advance', amount: 5 });
    assert.equal(response.status, 404);
    assert.equal(findOne.mock.callCount(), 1);
  });

  it('refuses a store the caller is not assigned to before touching records', async () => {
    const findOne = forbidQuery(Advance, 'findOne');
    const response = await call('PUT', `/advances/${recordId}?storeId=${foreignStore}`, { type: 'Advance', amount: 5 });
    assert.ok([403, 404].includes(response.status));
    assert.equal(findOne.mock.callCount(), 0);
  });
});

describe('unbounded attendance queries are capped', () => {
  it('rejects an attendance range longer than 366 days', async () => {
    const find = forbidQuery(Attendance, 'find');
    const response = await call('GET', `/attendance?storeId=${storeId}&from=2000-01-01&to=2026-01-01`);
    assert.equal(response.status, 400);
    assert.equal(find.mock.callCount(), 0);
  });

  it('rejects a weekly-roster range longer than 366 days', async () => {
    const find = forbidQuery(WeeklyRoster, 'find');
    const response = await call('GET', `/attendance/weekly-roster?storeId=${storeId}&from=1970-01-05&to=2026-01-04`);
    assert.equal(response.status, 400);
    assert.equal(find.mock.callCount(), 0);
  });
});

describe('employee responses never expose internal or secret fields', () => {
  const storedEmployee = () => ({
    _id: recordId, name: 'Employee', email: 'emp@example.test', role: 'employee', isActive: true,
    franchises: [storeId], password: '$2b$12$hash', sessionVersion: 3, createdBy: actorId, __v: 0,
    aadharDocument: { fileId: new mongoose.Types.ObjectId(), fileName: 'a.pdf', contentType: 'application/pdf', size: 10 },
    panDocument: { fileId: new mongoose.Types.ObjectId(), fileName: 'p.pdf', contentType: 'application/pdf', size: 10 },
  });

  it('franchise employee detail strips hashes, session counters, audit fields and storage ids', async () => {
    mock.method(User, 'findOne', (filter: Record<string, unknown>) => {
      assert.equal(String(filter.franchises), String(storeId));
      return queryResult(storedEmployee());
    });
    const response = await call('GET', `/users/${recordId}?storeId=${storeId}`);
    assert.equal(response.status, 200);
    const json = await response.json() as { user: Record<string, unknown> };
    assertNoSensitiveKeys(json);
    assert.deepEqual(json.user.aadharDocument, { fileName: 'a.pdf', contentType: 'application/pdf', size: 10 });
  });

  it('admin user detail uses an allowlisted projection and serializer', async () => {
    role = 'admin';
    let projection = '';
    mock.method(User, 'findOne', () => ({
      select(value: string) { projection = value; return this; },
      lean: async () => storedEmployee(),
    }));
    const response = await call('GET', `/users/${recordId}`);
    assert.equal(response.status, 200);
    assertNoSensitiveKeys(await response.json());
    for (const key of ['password', 'sessionVersion', 'aadhar', 'pan', 'bank']) assert.ok(!projection.includes(key), `projection must not select ${key}`);
  });

  it('admin user list never returns sensitive fields', async () => {
    role = 'admin';
    mock.method(User, 'find', () => queryResult([storedEmployee()]));
    mock.method(User, 'countDocuments', () => Promise.resolve(1));
    const response = await call('GET', '/users');
    assert.equal(response.status, 200);
    assertNoSensitiveKeys(await response.json());
  });

  it('returns 404 for a malformed document owner id without querying', async () => {
    const findOne = forbidQuery(User, 'findOne');
    const response = await call('GET', `/users/not-an-object-id/documents/aadhar?storeId=${storeId}`);
    assert.equal(response.status, 404);
    assert.equal(findOne.mock.callCount(), 0);
  });
});

describe('no-login employee credentials are unguessable', () => {
  it('generates distinct random placeholder emails and passwords', async () => {
    role = 'admin';
    const created: Record<string, unknown>[] = [];
    mock.method(Franchise, 'countDocuments', () => Promise.resolve(1));
    mock.method(User, 'exists', () => Promise.resolve(null));
    mock.method(User, 'create', async (doc: Record<string, unknown>) => {
      created.push(doc);
      return { _id: new mongoose.Types.ObjectId(), ...doc };
    });
    for (let index = 0; index < 2; index += 1) {
      const response = await call('POST', '/users', { name: `Worker ${index}`, role: 'employee', franchiseIds: [String(storeId)] });
      assert.equal(response.status, 201);
      assertNoSensitiveKeys(await response.json());
    }
    assert.equal(created.length, 2);
    for (const doc of created) {
      assert.match(String(doc.email), /^emp_[0-9a-f]{24}@nologin\.internal$/);
      assert.match(String(doc.password), /^\$2[aby]\$12\$/);
    }
    assert.notEqual(created[0].email, created[1].email);
    assert.notEqual(created[0].password, created[1].password);
  });
});
