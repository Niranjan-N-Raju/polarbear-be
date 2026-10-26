import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { SignJWT, decodeJwt } from 'jose';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { app } from '../src/app.js';
import { Advance } from '../src/models/Advance.js';
import { Incentive } from '../src/models/Incentive.js';
import { ExtraDay } from '../src/models/ExtraDay.js';
import { Franchise } from '../src/models/Franchise.js';
import { User, type UserRole } from '../src/models/User.js';
import { Withdrawal } from '../src/models/Withdrawal.js';
import { Sale } from '../src/models/Sale.js';
import { InventoryItem } from '../src/models/Inventory.js';
import { Attendance } from '../src/models/Attendance.js';
import { WeeklyRoster } from '../src/models/WeeklyRoster.js';
import { queryResult } from './helpers/franchiseApi.js';
import { SESSION_AUDIENCE, SESSION_ISSUER, signSessionToken } from '../src/utils/token.js';

const actorId = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();
const foreignStore = new mongoose.Types.ObjectId();
const resourceId = new mongoose.Types.ObjectId();
const secret = 'authorization-tests-only-not-a-production-secret';
const roles: UserRole[] = ['admin', 'sub_admin', 'franchise_admin', 'employee'];
type Endpoint = { method: string; path: string };
const endpoints = (path: string, methods: string[]): Endpoint[] => methods.map((method) => ({ path, method }));
const scopedRoutes: Endpoint[] = [
  ...endpoints('/dashboard', ['GET']),
  ...endpoints('/sales', ['GET', 'POST']),
  ...endpoints(`/sales/${resourceId}`, ['PUT']),
  ...endpoints('/products', ['GET']),
  ...endpoints('/inventory', ['GET', 'POST', 'PATCH']),
  ...endpoints('/withdrawals', ['GET', 'POST']),
  ...endpoints(`/withdrawals/${resourceId}`, ['PUT', 'DELETE']),
  ...endpoints('/pnl', ['GET']),
  ...endpoints('/pnl/inputs', ['GET', 'PUT']),
  ...endpoints('/stores/branding', ['GET', 'PUT']),
  ...endpoints('/stores/logo', ['GET', 'POST', 'DELETE']),
  ...['cycle', 'positions', 'shifts'].flatMap((path) => endpoints(`/stores/${path}`, ['GET', 'PUT'])),
  ...endpoints('/users', ['GET', 'POST']),
  ...endpoints(`/users/${resourceId}`, ['GET', 'PATCH', 'PUT', 'DELETE']),
  ...['aadhar', 'pan'].flatMap((type) => endpoints(`/users/${resourceId}/documents/${type}`, ['GET', 'POST', 'DELETE'])),
  ...endpoints('/attendance', ['GET', 'PUT', 'DELETE']),
  ...endpoints('/attendance/weekly-roster', ['GET', 'PUT']),
  ...endpoints('/salary', ['GET', 'PUT']),
  ...endpoints('/salary/slip', ['GET']),
  ...['advances', 'incentives', 'extra-days'].flatMap((path) => [
    ...endpoints(`/${path}`, ['GET', 'POST']),
    ...endpoints(`/${path}/${resourceId}`, ['PUT', 'DELETE']),
  ]),
];
const adminRoutes: Endpoint[] = [
  ...endpoints('/stores', ['POST', 'PATCH']),
  ...endpoints('/stores/archive', ['PATCH']),
  ...endpoints('/products', ['POST', 'PATCH', 'DELETE']),
];
const protectedRoutes = [
  ...scopedRoutes, ...adminRoutes,
  ...endpoints('/stores', ['GET']),
  ...endpoints('/me', ['GET', 'PATCH']),
  ...endpoints('/auth/extend', ['POST']),
  ...endpoints('/auth/logout', ['POST']),
];
let server: Server;
let baseUrl: string;
let token: string;
let role: UserRole;
let active: boolean;
let sessionVersion: number;
let assigned: mongoose.Types.ObjectId[];
let missing: boolean;
let archived: boolean;
const previousSecret = process.env.JWT_SECRET;

before(async () => {
  process.env.JWT_SECRET = secret;
  token = await signSessionToken({ id: String(actorId), name: 'Test', email: 'auth@example.test', role: 'admin' });
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
  active = true;
  sessionVersion = 0;
  assigned = [storeId];
  missing = false;
  archived = false;
  mock.method(User, 'findById', (id: unknown) => {
    assert.equal(String(id), String(actorId), 'authentication and self-profile must only look up the authenticated user');
    return queryResult(missing ? null : {
      _id: actorId, name: 'Test', email: 'auth@example.test', role, isActive: active,
      franchises: assigned, sessionVersion,
    });
  });
  mock.method(Franchise, 'find', (filter: Record<string, unknown>) => {
    assert.equal(filter.$or, undefined, 'store visibility must not include creator ownership');
    assert.equal(filter.createdBy, undefined, 'store visibility must not include creator ownership');
    const ids = (filter._id as { $in: string[] } | undefined)?.$in;
    assert.deepEqual(ids, assigned.map(String), 'store visibility must derive only from explicit assignments');
    return queryResult(assigned.map((_id) => ({ _id, isActive: !archived, archivedAt: archived ? new Date() : null })));
  });
});
afterEach(() => mock.restoreAll());

function payload(selectedStore = String(storeId)) {
  return {
    storeId: selectedStore, franchiseIds: [selectedStore], name: 'Test', storeCode: 'TEST',
    date: '2026-01-01', from: '2026-01-01', to: '2026-01-31', period: '2026-01',
    employeeId: String(resourceId), productId: String(resourceId), inventoryItemId: String(resourceId),
    totalSale: 100, swiggy: 0, zomato: 0, upi: 0, upiCharge: 0, expenses: [],
    amount: 100, days: 1, type: 'withdrawal', reason: 'Test',
    cycleType: 'calendar_month', positions: [], shifts: [], values: {},
    weekStart: '2026-01-05', records: [], entries: [], archived: true,
  };
}
async function request(endpoint: Endpoint, options: {
  bearer?: string | null; store?: string; body?: unknown; query?: string; headers?: Record<string, string>;
} = {}) {
  const query = new URLSearchParams({
    storeId: options.store ?? String(storeId), period: '2026-01', date: '2026-01-01',
    from: '2026-01-01', to: '2026-01-31', employeeId: String(resourceId), weekStart: '2026-01-05',
    id: String(resourceId),
  });
  if (options.query) for (const [key, value] of new URLSearchParams(options.query)) query.set(key, value);
  const bearer = options.bearer === undefined ? token : options.bearer;
  return fetch(`${baseUrl}${endpoint.path}?${query}`, {
    method: endpoint.method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...options.headers,
    },
    body: endpoint.method === 'GET' ? undefined : JSON.stringify(options.body ?? payload(options.store)),
  });
}

describe('complete registered API permission matrix', () => {
  for (const endpoint of protectedRoutes) {
    it(`requires bearer authentication: ${endpoint.method} ${endpoint.path}`, async () => {
      assert.equal((await request(endpoint, { bearer: null })).status, 401);
    });
  }
  for (const deniedRole of ['employee', 'sub_admin'] as const) {
    for (const endpoint of [...scopedRoutes, ...adminRoutes, { method: 'GET', path: '/stores' }]) {
      it(`denies ${deniedRole} business access: ${endpoint.method} ${endpoint.path}`, async () => {
        role = deniedRole;
        const response = await request(endpoint, {
          headers: { 'x-role': 'admin', 'x-user-id': String(actorId), 'x-store-id': String(storeId) },
        });
        assert.ok([403, 404].includes(response.status), `received ${response.status}`);
      });
    }
  }
  for (const endpoint of scopedRoutes) {
    it(`denies a foreign outlet: ${endpoint.method} ${endpoint.path}`, async () => {
      const response = await request(endpoint, {
        store: String(foreignStore),
        headers: { 'x-store-id': String(storeId), 'x-tenant-id': String(storeId) },
      });
      assert.equal(response.status, 403);
    });
  }
  for (const endpoint of adminRoutes) {
    it(`denies franchise-admin platform escalation: ${endpoint.method} ${endpoint.path}`, async () => {
      assert.equal((await request(endpoint)).status, 403);
    });
  }
  for (const selfRole of roles) {
    it(`allows ${selfRole} to read only their own profile`, async () => {
      role = selfRole;
      const response = await request({ method: 'GET', path: '/me' }, {
        query: `id=${resourceId}&userId=${resourceId}&role=admin`,
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { id: string }).id, String(actorId));
    });
  }
  it('keeps health public rather than accidentally applying platform-admin middleware', async () => {
    const response = await request({ method: 'GET', path: '/health' }, { bearer: null });
    assert.equal(response.status, 503);
  });
});

describe('JWT and current-account enforcement', () => {
  async function craftedToken(changes: Record<string, unknown> = {}, signingSecret = secret, algorithm = 'HS256') {
    return new SignJWT({
      id: String(actorId), role: 'admin', sessionVersion: 0, sessionStart: Math.floor(Date.now() / 1000),
      iss: SESSION_ISSUER, aud: SESSION_AUDIENCE, iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300, ...changes,
    }).setProtectedHeader({ alg: algorithm }).sign(new TextEncoder().encode(signingSecret));
  }
  const me = { method: 'GET', path: '/me' };
  it('issues API-bound tokens with an eight-hour expiry', () => {
    const claims = decodeJwt(token);
    assert.equal(claims.iss, SESSION_ISSUER);
    assert.equal(claims.aud, SESSION_AUDIENCE);
    assert.equal(claims.exp! - claims.iat!, 8 * 60 * 60);
  });
  for (const [name, changes] of [
    ['expired', { exp: 1 }],
    ['future not-before', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
    ['wrong issuer', { iss: 'another-service' }],
    ['wrong audience', { aud: 'another-api' }],
    ['missing issuer', { iss: undefined }],
    ['missing audience', { aud: undefined }],
    ['missing expiry', { exp: undefined }],
    ['missing issued-at', { iat: undefined }],
    ['future issued-at', { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ['older than eight hours despite an unexpired exp', { iat: Math.floor(Date.now() / 1000) - 28801 }],
    ['malformed user ID', { id: { $ne: null } }],
    ['invalid user ID', { id: 'not-an-object-id' }],
    ['missing session version', { sessionVersion: undefined }],
    ['negative session version', { sessionVersion: -1 }],
    ['noninteger session version', { sessionVersion: 0.5 }],
    ['revoked version', { sessionVersion: 9 }],
    ['missing session start', { sessionStart: undefined }],
    ['non-integer session start', { sessionStart: 'yesterday' }],
    ['future session start', { sessionStart: Math.floor(Date.now() / 1000) + 3600 }],
    ['session start older than the 24-hour absolute cap', { sessionStart: Math.floor(Date.now() / 1000) - 24 * 60 * 60 - 1 }],
  ] as const) {
    it(`rejects ${name}`, async () => {
      assert.equal((await request(me, { bearer: await craftedToken(changes) })).status, 401);
    });
  }
  it('rejects wrong signatures, non-HS256 algorithms and malformed tokens', async () => {
    for (const bearer of [await craftedToken({}, 'wrong-secret'), await craftedToken({}, secret, 'HS384'), 'invalid.token.value']) {
      assert.equal((await request(me, { bearer })).status, 401);
    }
  });
  it('uses the current database role rather than the signed role or role headers', async () => {
    role = 'employee';
    const response = await request({ method: 'GET', path: '/dashboard' }, {
      bearer: await craftedToken({ role: 'admin' }), headers: { 'x-role': 'admin' },
    });
    assert.equal(response.status, 403);
  });
  it('rejects inactive, deleted and revoked accounts on every request', async () => {
    active = false;
    assert.equal((await request(me)).status, 401);
    active = true; missing = true;
    assert.equal((await request(me)).status, 401);
    missing = false; sessionVersion = 1;
    assert.equal((await request(me)).status, 401);
  });
  it('rechecks store assignments after removal rather than trusting token or headers', async () => {
    assigned = [];
    assert.equal((await request({ method: 'GET', path: '/inventory' })).status, 403);
  });
  it('rejects an over-cap session on scoped routes and session extension, not just /me', async () => {
    const bearer = await craftedToken({ role: 'franchise_admin', sessionStart: Math.floor(Date.now() / 1000) - 25 * 60 * 60 });
    assert.equal((await request({ method: 'GET', path: '/inventory' }, { bearer })).status, 401);
    assert.equal((await request({ method: 'POST', path: '/auth/extend' }, { bearer })).status, 401);
  });
  it('extends a session without moving its start or exceeding the 24-hour absolute cap', async () => {
    const sessionStart = Math.floor(Date.now() / 1000) - 20 * 60 * 60;
    mock.method(mongoose.connection, 'collection', (name: string) => {
      assert.equal(name, 'users');
      return { findOne: async () => ({ _id: actorId, name: 'Test', email: 'auth@example.test', role, sessionVersion: 0 }) };
    });
    const bearer = await craftedToken({ role, sessionStart });
    const response = await request({ method: 'POST', path: '/auth/extend' }, { bearer });
    assert.equal(response.status, 200);
    const claims = decodeJwt((await response.json() as { token: string }).token);
    assert.equal(claims.sessionStart, sessionStart);
    assert.ok(claims.exp! <= sessionStart + 24 * 60 * 60, 'extended token must not outlive the absolute cap');
    assert.ok(claims.exp! < claims.iat! + 8 * 60 * 60, 'cap must shorten the normal eight-hour window');
  });
  it('stamps a fresh session start on newly issued tokens', () => {
    const claims = decodeJwt(token);
    assert.equal(typeof claims.sessionStart, 'number');
    assert.ok(claims.exp! <= (claims.sessionStart as number) + 24 * 60 * 60);
  });
});

describe('explicit store assignment only', () => {
  it('denies a store the user created but is not assigned to', async () => {
    assigned = [];
    for (const endpoint of [{ method: 'GET', path: '/dashboard' }, { method: 'POST', path: '/sales' }]) {
      assert.equal((await request(endpoint)).status, 403);
    }
  });
  it('refuses login for store users with no explicit assignments, without consulting store ownership', async () => {
    const password = 'A-valid-password-123!';
    const hash = await bcrypt.hash(password, 4);
    for (const userRole of ['franchise_admin', 'employee']) {
      const collections: string[] = [];
      mock.method(mongoose.connection, 'collection', (name: string) => {
        collections.push(name);
        return { findOne: async () => ({ _id: actorId, name: 'Owner', email: 'owner@example.test', role: userRole, password: hash, franchises: [] }) };
      });
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${collections.length + (userRole === 'employee' ? 2 : 1)}` },
        body: JSON.stringify({ email: `owner-${userRole}@example.test`, password }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json() as { token?: string }).token, undefined);
      assert.deepEqual(collections, ['users']);
      mock.restoreAll();
    }
  });
});

describe('store creators have no store-data access', () => {
  it('does not assign a newly created store to the creating administrator', async () => {
    role = 'admin';
    const updates = mock.method(User, 'findByIdAndUpdate', () => queryResult(null));
    const assignments = mock.method(User, 'updateOne', () => queryResult(null));
    const created = mock.method(Franchise, 'create', async (doc: Record<string, unknown>) => ({ _id: storeId, ...doc }));
    const response = await request({ method: 'POST', path: '/stores' }, {
      body: { name: 'New Store', storeCode: 'NEW1', storeType: 'company' },
    });
    assert.equal(response.status, 201);
    assert.equal(created.mock.callCount(), 1);
    assert.equal(String(created.mock.calls[0].arguments[0].createdBy), String(actorId));
    assert.equal(updates.mock.callCount(), 0, 'creator must not be auto-assigned to the store');
    assert.equal(assignments.mock.callCount(), 0, 'creator must not be auto-assigned to the store');
  });
  // Admin platform routers (global dashboard, user management, product catalog) share these paths.
  const adminPlatformPaths = new Set(['/dashboard', '/products', '/users', `/users/${resourceId}`]);
  for (const platformRole of ['admin', 'sub_admin'] as const) {
    for (const endpoint of scopedRoutes.filter((route) => platformRole !== 'admin' || !adminPlatformPaths.has(route.path))) {
      it(`denies ${platformRole} store data even with a legacy assignment: ${endpoint.method} ${endpoint.path}`, async () => {
        role = platformRole;
        assigned = [storeId];
        const response = await request(endpoint);
        assert.ok([403, 404].includes(response.status), `received ${response.status}`);
      });
    }
  }
  it('keeps store-data access for the assigned franchise admin', async () => {
    mock.method(Franchise, 'findById', () => queryResult({ _id: storeId, salaryCycleType: 'calendar_month' }));
    assert.equal((await request({ method: 'GET', path: '/stores/cycle' })).status, 200);
  });
});

describe('archived stores are read-only for store users', () => {
  it('still allows reads of an archived assigned store', async () => {
    archived = true;
    mock.method(Franchise, 'findById', () => queryResult({ _id: storeId, salaryCycleType: 'calendar_month' }));
    assert.equal((await request({ method: 'GET', path: '/stores/cycle' })).status, 200);
  });
  for (const endpoint of scopedRoutes.filter((route) => route.method !== 'GET')) {
    it(`blocks writes to an archived store: ${endpoint.method} ${endpoint.path}`, async () => {
      archived = true;
      const response = await request(endpoint);
      assert.equal(response.status, 403);
      assert.match((await response.json() as { message: string }).message, /archived/i);
    });
  }
});

describe('administrator-on-administrator management', () => {
  const otherAdmin = { _id: resourceId, role: 'admin', isActive: true, franchises: [], sessionVersion: 0 };
  function asAdmin(target: Record<string, unknown>) {
    role = 'admin';
    mock.method(User, 'findById', (id: unknown) => queryResult(String(id) === String(actorId)
      ? { _id: actorId, role: 'admin', isActive: true, sessionVersion: 0 }
      : target));
  }
  it('forbids an admin from modifying another admin', async () => {
    const save = mock.fn(async () => undefined);
    asAdmin({ ...otherAdmin, save });
    for (const body of [{ name: 'Renamed' }, { isActive: false }, { role: 'employee', franchiseIds: [String(storeId)] }]) {
      assert.equal((await request({ method: 'PATCH', path: `/users/${resourceId}` }, { body })).status, 403);
    }
    assert.equal(save.mock.callCount(), 0);
  });
  it('forbids an admin from deleting another admin', async () => {
    const deleteOne = mock.fn(async () => undefined);
    asAdmin({ ...otherAdmin, deleteOne });
    assert.equal((await request({ method: 'DELETE', path: `/users/${resourceId}` })).status, 403);
    assert.equal(deleteOne.mock.callCount(), 0);
  });
  it('still lets an admin manage non-admin users', async () => {
    const save = mock.fn(async () => undefined);
    asAdmin({ _id: resourceId, role: 'employee', franchises: [storeId], sessionVersion: 0, name: 'Emp', save });
    assert.equal((await request({ method: 'PATCH', path: `/users/${resourceId}` }, { body: { name: 'Renamed' } })).status, 200);
    assert.equal(save.mock.callCount(), 1);
  });
});

describe('resource-level tenant predicates', () => {
  it('returns an explicit error rather than losing rejected payroll authorization promises', async () => {
    mock.method(Advance, 'findOne', () => { throw new Error('simulated lookup failure'); });
    const response = await request({ method: 'PUT', path: `/advances/${resourceId}` });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /simulated lookup failure/);
  });
  for (const [path, model] of [['advances', Advance], ['incentives', Incentive], ['extra-days', ExtraDay]] as const) {
    it(`does not reveal or update another store's ${path} ID`, async () => {
      const unscoped = mock.method(model, 'findById', () => { throw new Error('unscoped lookup'); });
      const scoped = mock.method(model, 'findOne', (filter: Record<string, unknown>) => {
        assert.deepEqual(filter, { _id: String(resourceId), franchise: storeId });
        return queryResult(null);
      });
      const response = await request({ method: 'PUT', path: `/${path}/${resourceId}` });
      assert.equal(response.status, 404);
      assert.equal(unscoped.mock.callCount(), 0);
      assert.equal(scoped.mock.callCount(), 1);
    });
  }
  for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) {
    it(`cannot ${method} a foreign employee or elevate their role`, async () => {
      mock.method(User, 'findOne', (filter: Record<string, unknown>) => {
        assert.deepEqual(filter, { _id: String(resourceId), role: 'employee', franchises: storeId });
        return queryResult(null);
      });
      assert.equal((await request({ method, path: `/users/${resourceId}` }, {
        body: { ...payload(), role: 'admin', franchises: [String(foreignStore)] },
      })).status, 404);
    });
  }
  for (const type of ['aadhar', 'pan']) {
    for (const method of ['GET', 'DELETE']) {
      it(`cannot ${method} another store's ${type} document`, async () => {
        mock.method(User, 'findOne', (filter: Record<string, unknown>) => {
          assert.deepEqual(filter, { _id: String(resourceId), role: 'employee', franchises: storeId });
          return queryResult(null);
        });
        assert.equal((await request({ method, path: `/users/${resourceId}/documents/${type}` })).status, 404);
      });
    }
    it(`cannot upload another store's ${type} document`, async () => {
      mock.method(User, 'findOne', (filter: Record<string, unknown>) => {
        assert.deepEqual(filter, { _id: String(resourceId), role: 'employee', franchises: storeId });
        return queryResult(null);
      });
      assert.equal((await request({ method: 'POST', path: `/users/${resourceId}/documents/${type}` }, {
        body: { ...payload(), base64: Buffer.from('%PDF-test').toString('base64') },
      })).status, 404);
    });
  }
  it('cannot create payroll for a foreign employee', async () => {
    mock.method(User, 'findOne', (filter: Record<string, unknown>) => {
      assert.deepEqual(filter, { _id: String(resourceId), role: 'employee', franchises: storeId });
      return queryResult(null);
    });
    const create = mock.method(Advance, 'create', async () => { throw new Error('must not write'); });
    assert.equal((await request({ method: 'POST', path: '/advances' })).status, 404);
    assert.equal(create.mock.callCount(), 0);
  });
  for (const method of ['PUT', 'DELETE']) {
    it(`scopes ${method} withdrawal to both record and store`, async () => {
      const operation = method === 'PUT' ? 'findOneAndUpdate' : 'findOneAndDelete';
      mock.method(Withdrawal, operation, (filter: Record<string, unknown>) => {
        assert.deepEqual(filter, { _id: String(resourceId), franchise: storeId });
        return queryResult(null);
      });
      assert.equal((await request({ method, path: `/withdrawals/${resourceId}` })).status, 404);
    });
  }
  it('scopes sale updates even when body attempts to set another franchise', async () => {
    mock.method(Sale, 'findOne', () => queryResult(null));
    mock.method(Sale, 'findOneAndUpdate', (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      assert.deepEqual(filter, { _id: resourceId, franchise: storeId });
      assert.equal(update.$set.franchise, undefined);
      assert.equal(update.$set.createdBy, undefined);
      return queryResult(null);
    });
    assert.equal((await request({ method: 'PUT', path: `/sales/${resourceId}` }, {
      body: { ...payload(), franchise: String(foreignStore), createdBy: String(resourceId) },
    })).status, 404);
  });
  it('scopes inventory consumption to both item and store', async () => {
    mock.method(InventoryItem, 'findOne', (filter: Record<string, unknown>) => {
      assert.equal(String(filter._id), String(resourceId));
      assert.equal(filter.storeId, String(storeId));
      return queryResult(null);
    });
    assert.equal((await request({ method: 'PATCH', path: '/inventory' })).status, 404);
  });
  it('scopes attendance deletion to store, employee and date', async () => {
    mock.method(Attendance, 'findOneAndDelete', (filter: Record<string, unknown>) => {
      assert.deepEqual(filter, { franchise: storeId, employee: String(resourceId), date: '2026-01-01' });
      return queryResult(null);
    });
    assert.equal((await request({ method: 'DELETE', path: '/attendance' })).status, 404);
  });
    it('does not write attendance for an employee outside the selected store', async () => {
      mock.method(User, 'find', (filter: Record<string, unknown>) => {
        assert.equal(filter.role, 'employee');
        assert.equal(String(filter.franchises), String(storeId));
        return queryResult([]);
      });
      const write = mock.method(Attendance, 'bulkWrite', async () => { throw new Error('must not write'); });
      const response = await request({ method: 'PUT', path: '/attendance' }, {
        body: { ...payload(), records: [{ employeeId: String(resourceId), status: 'Present' }] },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { skippedCount: number }).skippedCount, 1);
      assert.equal(write.mock.callCount(), 0);
    });
    it('rejects a roster containing a foreign employee without updating it', async () => {
      mock.method(Franchise, 'findById', () => queryResult({ _id: storeId, shifts: [] }));
      mock.method(User, 'find', (filter: Record<string, unknown>) => {
        assert.equal(filter.role, 'employee');
        assert.equal(String(filter.franchises), String(storeId));
        return queryResult([]);
      });
      const write = mock.method(WeeklyRoster, 'findOneAndUpdate', () => { throw new Error('must not write'); });
      const days = Array.from({ length: 7 }, (_, index) => ({ date: `2026-01-${String(5 + index).padStart(2, '0')}`, shift: 'off' }));
      assert.equal((await request({ method: 'PUT', path: '/attendance/weekly-roster' }, {
        body: { ...payload(), entries: [{ employeeId: String(resourceId), days }] },
      })).status, 400);
      assert.equal(write.mock.callCount(), 0);
    });
    it('does not create a privileged account through employee body mass assignment', async () => {
      let fields: Record<string, unknown> | undefined;
      mock.method(User, 'create', async (input: Record<string, unknown>) => {
        fields = input;
        return { _id: resourceId };
      });
      assert.equal((await request({ method: 'POST', path: '/users' }, {
        body: { ...payload(), role: 'admin', franchises: [String(foreignStore)], createdBy: String(resourceId), sessionVersion: 99 },
      })).status, 201);
      assert.equal(fields?.role, 'employee');
      assert.deepEqual(fields?.franchises, [storeId]);
      assert.equal(String(fields?.createdBy), String(actorId));
      assert.equal(fields?.sessionVersion, undefined);
    });
    it('cannot bypass a foreign body store ID with an authorized query or tenant header', async () => {
      assert.equal((await request({ method: 'POST', path: '/sales' }, {
        body: payload(String(foreignStore)), headers: { 'x-tenant-id': String(storeId) },
      })).status, 403);
    });
    it('does not accept duplicate, invalid or operator-shaped store IDs as authorization', async () => {
      for (const id of ['not-an-id', `${storeId},${foreignStore}`, '{"$ne":null}']) {
        assert.equal((await request({ method: 'GET', path: '/inventory' }, { store: id })).status, 400);
      }
      assert.equal((await request({ method: 'POST', path: '/inventory' }, {
        store: '', body: { ...payload(), storeId: { $ne: null } },
      })).status, 400);
    });
  it('preserves platform-admin ownership checks for store mutations', async () => {
    role = 'admin';
    mock.method(Franchise, 'findOneAndUpdate', (filter: Record<string, unknown>) => {
      assert.deepEqual(filter, { _id: String(resourceId), createdBy: actorId });
      return queryResult(null);
    });
    mock.method(Franchise, 'exists', async () => ({ _id: resourceId }));
    for (const path of ['/stores', '/stores/archive']) {
      assert.equal((await request({ method: 'PATCH', path })).status, 403);
    }
  });
});

describe('self-service password and profile isolation', () => {
  it('rejects inactive login and operator-shaped login fields before issuing a token', async () => {
    const lookup = mock.fn(async (filter: Record<string, unknown>) => {
      assert.deepEqual(filter, { email: 'disabled@example.test', isActive: { $ne: false } });
      return null;
    });
    mock.method(mongoose.connection, 'collection', (name: string) => {
      assert.equal(name, 'users');
      return { findOne: lookup };
    });
    const postLogin = (body: unknown) => fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const inactive = await postLogin({ email: 'disabled@example.test', password: 'A-valid-password-123!' });
    assert.equal(inactive.status, 401);
    assert.equal((await inactive.json() as { token?: string }).token, undefined);
    assert.equal((await postLogin({ email: { $ne: null }, password: { $ne: null } })).status, 400);
    assert.equal(lookup.mock.callCount(), 1);
  });
  it('does not allow admin creation or promotion through the admin user endpoints', async () => {
    role = 'admin';
    const create = mock.method(User, 'create', async () => { throw new Error('must not create'); });
    const save = mock.fn(async () => { throw new Error('must not save'); });
    mock.method(User, 'findById', (id: unknown) => queryResult(String(id) === String(actorId)
      ? { _id: actorId, role: 'admin', isActive: true, sessionVersion: 0 }
      : { _id: resourceId, role: 'employee', franchises: [storeId], save }));
    for (const method of ['POST', 'PATCH']) {
      const response = await request({ method, path: method === 'POST' ? '/users' : `/users/${resourceId}` }, {
        body: { ...payload(), role: 'admin', franchiseIds: [String(storeId)] },
      });
      assert.equal(response.status, 403);
    }
    assert.equal(create.mock.callCount(), 0);
    assert.equal(save.mock.callCount(), 0);
  });
  it('invalidates the target account sessions after an admin changes its assignments or role', async () => {
    role = 'admin';
    const target = {
      _id: resourceId, role: 'franchise_admin', franchises: [storeId], sessionVersion: 0,
      save: mock.fn(async () => undefined),
    };
    mock.method(User, 'findById', (id: unknown) => queryResult(String(id) === String(actorId)
      ? { _id: actorId, role: 'admin', isActive: true, sessionVersion: 0 }
      : target));
    mock.method(Franchise, 'countDocuments', async () => 1);
    assert.equal((await request({ method: 'PATCH', path: `/users/${resourceId}` }, {
      body: { franchiseIds: [String(foreignStore)] },
    })).status, 200);
    assert.equal(target.sessionVersion, 1);
    assert.deepEqual(target.franchises.map(String), [String(foreignStore)]);
    assert.equal((await request({ method: 'PATCH', path: `/users/${resourceId}` }, {
      body: { role: 'employee' },
    })).status, 200);
    assert.equal(target.sessionVersion, 2);
    assert.equal(target.role, 'employee');
    assert.equal(target.save.mock.callCount(), 2);
  });
  it('ignores privilege/identity fields in self-service profile updates', async () => {
    role = 'employee';
    const doc = {
      _id: actorId, name: 'Original', email: 'auth@example.test', role, sessionVersion: 0,
      save: mock.fn(async () => undefined),
    };
    mock.method(User, 'findById', (id: unknown) => {
      assert.equal(String(id), String(actorId));
      return queryResult(doc);
    });
    const response = await request({ method: 'PATCH', path: '/me' }, {
      body: { name: 'Updated', id: String(resourceId), role: 'admin', franchises: [String(foreignStore)], sessionVersion: 99 },
    });
    assert.equal(response.status, 200);
    assert.equal(doc.role, 'employee');
    assert.equal(doc.sessionVersion, 0);
    assert.equal(doc.name, 'Updated');
  });
  it('requires the current password and revokes old tokens after a password change', async () => {
    const doc = {
      _id: actorId, name: 'Test', email: 'auth@example.test', role: 'employee',
      password: await bcrypt.hash('OriginalPass12!', 4), sessionVersion: 0,
      save: mock.fn(async () => undefined),
    };
    mock.method(User, 'findById', () => queryResult(doc));
    const endpoint = { method: 'PATCH', path: '/me' };
    assert.equal((await request(endpoint, { body: { newPassword: 'ChangedPass12!' } })).status, 400);
    assert.equal((await request(endpoint, { body: { currentPassword: 'wrong', newPassword: 'ChangedPass12!' } })).status, 400);
    assert.equal(doc.save.mock.callCount(), 0);
    const response = await request(endpoint, { body: { currentPassword: 'OriginalPass12!', newPassword: 'ChangedPass12!' } });
    assert.equal(response.status, 200);
    assert.equal(doc.sessionVersion, 1);
    assert.equal(await bcrypt.compare('ChangedPass12!', doc.password), true);
    const renewed = (await response.json() as { token: string }).token;
    assert.equal((await request({ method: 'GET', path: '/me' })).status, 401);
    assert.equal((await request({ method: 'GET', path: '/me' }, { bearer: renewed })).status, 200);
  });
});
