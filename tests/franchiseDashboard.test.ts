import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Franchise } from '../src/models/Franchise.js';
import { Sale } from '../src/models/Sale.js';
import { User } from '../src/models/User.js';
import { signSessionToken } from '../src/utils/token.js';

const userId = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();
const otherStoreId = new mongoose.Types.ObjectId();
let server: Server;
let url: string;
let token: string;
let role = 'franchise_admin';
const previousSecret = process.env.JWT_SECRET;
let saleQueries: unknown[];
let employeeQueries: unknown[];
let storeQueries: { filter: Record<string, unknown>; projection: string }[];

function queryResult(value: unknown) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => value,
  };
}

before(async () => {
  process.env.JWT_SECRET = 'unit-test-only-not-a-production-secret';
  token = await signSessionToken({ id: String(userId), name: 'Test', email: 'test@example.test', role });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  url = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

beforeEach(() => {
  role = 'franchise_admin';
  saleQueries = [];
  employeeQueries = [];
  storeQueries = [];
  mock.method(User, 'findById', () => queryResult({
    _id: userId, name: 'Test', email: 'test@example.test', role,
    sessionVersion: 0, isActive: true, franchises: [storeId],
  }));
  mock.method(Franchise, 'find', (query: Record<string, unknown>) => {
    const entry = { filter: query, projection: '' };
    storeQueries.push(entry);
    return {
      ...queryResult(query.$or ? [{ _id: storeId }] : [{ _id: storeId, name: 'Central' }]),
      select(projection: string) { entry.projection = projection; return this; },
    };
  });
  mock.method(User, 'countDocuments', async (query: unknown) => { employeeQueries.push(query); return 3; });
  mock.method(User, 'find', (query: unknown) => { employeeQueries.push(query); return queryResult([]); });
  mock.method(Sale, 'aggregate', async (pipeline: unknown) => { saleQueries.push(pipeline); return [{ total: 1200 }]; });
  mock.method(Sale, 'find', (query: unknown) => {
    saleQueries.push(query);
    return queryResult([{ date: '2026-10-04', totalSale: 1200, swiggy: 0, zomato: 0, upi: 600, cash: 600, expenses: [] }]);
  });
});
afterEach(() => mock.restoreAll());

async function request(path: string) {
  return fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function send(method: 'POST' | 'PUT', path: string, body: unknown) {
  return fetch(`${url}${path}`, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validSale = {
  storeId: String(storeId),
  date: '2026-01-15',
  totalSale: 1000,
  swiggy: 100,
  zomato: 50,
  upi: 300,
  upiCharge: 5,
  expenses: [{ name: ' Milk ', amount: 120 }, { name: 'Gas', amount: 30 }],
};

describe('franchise dashboard API', () => {
  it('requires authentication and blocks unsupported roles', async () => {
    assert.equal((await fetch(`${url}/stores`)).status, 401);
    role = 'employee';
    assert.equal((await request(`/dashboard?storeId=${storeId}`)).status, 403);
    assert.equal(saleQueries.length, 0);
  });

  it('lists only explicitly assigned stores without leaking owner details', async () => {
    const result = await request('/stores');
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { franchises: [{ _id: String(storeId), name: 'Central' }] });
    assert.deepEqual(storeQueries[0].filter, { _id: { $in: [String(storeId)] } });
    assert.deepEqual(storeQueries[1], {
      filter: { _id: { $in: [String(storeId)] } },
      projection: '_id name address storeCode isActive archivedAt',
    });
  });

  it('requires an explicit valid selected store, without falling back to all stores', async () => {
    assert.equal((await request('/dashboard')).status, 400);
    assert.equal((await request('/dashboard?storeId=invalid')).status, 400);
    assert.equal((await request(`/dashboard?storeId=${otherStoreId}`)).status, 403);
    assert.equal((await request(`/sales?storeId=${otherStoreId}&from=2026-10-01&to=2026-10-31`)).status, 403);
    assert.equal(saleQueries.length, 0);
  });

  it('scopes every dashboard database query to the authorized selected store', async () => {
    const result = await request(`/dashboard?storeId=${storeId}`);
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.storeCount, 1);
    assert.equal(data.employeeSummary, 3);
    assert.equal(data.salesSummary, 1200);
    assert.equal(data.attendanceSummary, 0);
    assert.equal(data.attritionTrend.length, 6);
    assert.equal(data.weekdayPerformance.length, 7);
    assert.equal(data.paymentMixTrend[0].upiPercent, 50);
    assert.ok(saleQueries.every((query) => JSON.stringify(query).includes(String(storeId))));
    assert.ok(employeeQueries.every((query) => JSON.stringify(query).includes(String(storeId))));
  });

  it('rechecks removed assignments, validates dates, and returns scoped trend data', async () => {
    assert.equal((await request(`/sales?storeId=${storeId}&from=2026-02-30&to=2026-10-31`)).status, 400);
    assert.equal((await request(`/sales?storeId=${storeId}&from=2026-10-31&to=2026-10-01`)).status, 400);
    assert.equal((await request(`/sales?storeId=${storeId}&from=2020-01-01&to=2026-10-31`)).status, 400);
    const result = await request(`/sales?storeId=${storeId}&from=2026-10-01&to=2026-10-31`);
    assert.equal(result.status, 200);
    const sale = (await result.json()).sales[0];
    assert.equal(sale.totalSale, 1200);
    assert.equal(sale.upiCharge, 0);
    assert.equal(sale.totalExpenses, 0);
    assert.equal(sale.bankingCash, 600);
    assert.deepEqual(saleQueries, [{ franchise: storeId, date: { $gte: '2026-10-01', $lte: '2026-10-31' } }]);
    mock.method(Franchise, 'find', () => queryResult([]));
    assert.equal((await request(`/dashboard?storeId=${storeId}`)).status, 403);
  });

  it('accepts a 366-day difference but rejects a 367-day difference', async () => {
    assert.equal((await request(`/sales?storeId=${storeId}&from=2024-01-01&to=2025-01-01`)).status, 200);
    assert.equal((await request(`/sales?storeId=${storeId}&from=2024-01-01&to=2025-01-02`)).status, 400);
    assert.equal(saleQueries.length, 1);
  });

  it('preserves the existing administrator dashboard without requiring a store selection', async () => {
    role = 'admin';
    mock.method(Franchise, 'countDocuments', async () => 2);
    const result = await request('/dashboard');
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      totalStores: 2, activeStores: 2, inactiveStores: 0, franchiseStores: 2, companyStores: 2,
      totalUsers: 3, storeAdmins: 3, subAdmins: 3, employees: 3,
    });
    assert.equal(saleQueries.length, 0);
    assert.equal(storeQueries.length, 0);
  });

  it('creates a sale with derived cash, expense and banking totals', async () => {
    let created: Record<string, unknown> | undefined;
    mock.method(Sale, 'findOne', () => queryResult(null));
    mock.method(Sale, 'create', async (doc: Record<string, unknown>) => { created = doc; return { _id: 'sale-1', ...doc }; });
    const result = await send('POST', '/sales', validSale);
    assert.equal(result.status, 201);
    assert.equal((await result.json()).message, 'Sale saved successfully.');
    assert.ok(created);
    assert.equal(created.cash, 550);
    assert.equal(created.totalExpenses, 150);
    assert.equal(created.bankingCash, 400);
    assert.equal(String(created.franchise), String(storeId));
    assert.equal(String(created.createdBy), String(userId));
    assert.deepEqual(created.expenses, [{ name: 'Milk', amount: 120 }, { name: 'Gas', amount: 30 }]);
  });

  it('rejects invalid, future, duplicate and unauthorized sales', async () => {
    const create = mock.method(Sale, 'create', async () => ({}));
    mock.method(Sale, 'findOne', () => queryResult(null));
    assert.equal((await send('POST', '/sales', { ...validSale, totalSale: -1 })).status, 400);
    assert.equal((await send('POST', '/sales', { ...validSale, upi: '12' })).status, 400);
    assert.equal((await send('POST', '/sales', { ...validSale, date: '2026-02-30' })).status, 400);
    const future = await send('POST', '/sales', { ...validSale, date: '2999-01-01' });
    assert.equal(future.status, 400);
    assert.equal((await future.json()).message, 'Date cannot be in the future.');
    assert.equal((await send('POST', '/sales', { ...validSale, expenses: [{ name: ' ', amount: 1 }] })).status, 400);
    assert.equal((await send('POST', '/sales', { ...validSale, storeId: String(otherStoreId) })).status, 403);
    mock.method(Sale, 'findOne', () => queryResult({ _id: 'existing' }));
    assert.equal((await send('POST', '/sales', validSale)).status, 409);
    assert.equal(create.mock.callCount(), 0);
    mock.method(Sale, 'findOne', () => queryResult(null));
    mock.method(Sale, 'create', async () => { throw Object.assign(new Error('dup'), { code: 11000 }); });
    assert.equal((await send('POST', '/sales', validSale)).status, 409);
  });

  it('updates only sales inside the authorized store', async () => {
    const saleId = new mongoose.Types.ObjectId();
    let duplicateFilter: Record<string, unknown> | undefined;
    let updateFilter: Record<string, unknown> | undefined;
    mock.method(Sale, 'findOne', (filter: Record<string, unknown>) => { duplicateFilter = filter; return queryResult(null); });
    mock.method(Sale, 'findOneAndUpdate', (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      updateFilter = filter;
      return queryResult({ _id: saleId, ...update.$set });
    });
    assert.equal((await send('PUT', '/sales/invalid', validSale)).status, 400);
    const result = await send('PUT', `/sales/${saleId}`, validSale);
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.message, 'Sale updated successfully.');
    assert.equal(data.sale.bankingCash, 400);
    assert.deepEqual(duplicateFilter, { franchise: storeId, date: validSale.date, _id: { $ne: saleId } });
    assert.deepEqual(updateFilter, { _id: saleId, franchise: storeId });
    mock.method(Sale, 'findOneAndUpdate', () => queryResult(null));
    const missing = await send('PUT', `/sales/${saleId}`, validSale);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).message, 'Sale not found.');
  });
});
