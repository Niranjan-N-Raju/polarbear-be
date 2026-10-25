import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Franchise } from '../src/models/Franchise.js';
import { DumpedInventory, InventoryItem, Product } from '../src/models/Inventory.js';
import { User } from '../src/models/User.js';
import { signSessionToken } from '../src/utils/token.js';

const userId = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();
const otherStoreId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const itemId = new mongoose.Types.ObjectId();
let server: Server;
let url: string;
let token: string;
const previousSecret = process.env.JWT_SECRET;

function queryResult(value: unknown) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => value,
  };
}

function today(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

before(async () => {
  process.env.JWT_SECRET = 'unit-test-only-not-a-production-secret';
  token = await signSessionToken({ id: String(userId), name: 'Test', email: 'test@example.test', role: 'franchise_admin' });
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
  mock.method(User, 'findById', () => queryResult({
    _id: userId, name: 'Test', email: 'test@example.test', role: 'franchise_admin',
    sessionVersion: 0, isActive: true, franchises: [storeId],
  }));
  mock.method(Franchise, 'find', () => queryResult([{ _id: storeId }]));
});
afterEach(() => mock.restoreAll());

async function call(method: string, path: string, body?: unknown) {
  return fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('franchise inventory API', () => {
  it('rejects stores the franchise admin cannot access', async () => {
    const response = await call('GET', `/inventory?storeId=${otherStoreId}`);
    assert.equal(response.status, 403);
  });

  it('lists in-stock items for the store', async () => {
    let filter: Record<string, unknown> = {};
    mock.method(InventoryItem, 'find', (query: Record<string, unknown>) => {
      filter = query;
      return queryResult([{ _id: itemId, productId, product: 'Milk', quantity: 4, expiryDate: '2026-01-01' }]);
    });
    const response = await call('GET', `/inventory?storeId=${storeId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(filter, { storeId: String(storeId), quantity: { $gt: 0 } });
    const body = await response.json() as { items: { _id: string; quantity: number }[] };
    assert.equal(body.items[0]?._id, String(itemId));
    assert.equal(body.items[0]?.quantity, 4);
  });

  it('validates and creates comma-separated products', async () => {
    let response = await call('POST', '/products', { storeId: String(storeId), name: ' , ' });
    assert.equal(response.status, 400);
    response = await call('POST', '/products', { storeId: String(storeId), name: 'Milk, milk' });
    assert.equal(response.status, 409);

    mock.method(Product, 'find', () => queryResult([]));
    const insertMany = mock.method(Product.collection, 'insertMany', async () => ({}));
    response = await call('POST', '/products', { storeId: String(storeId), name: 'Milk, Bread' });
    assert.equal(response.status, 201);
    const body = await response.json() as { products: { name: string; normalizedName: string }[] };
    assert.deepEqual(body.products.map((product) => product.normalizedName), ['milk', 'bread']);
    assert.equal(insertMany.mock.callCount(), 1);
  });

  it('rejects products that already exist without inserting', async () => {
    mock.method(Product, 'find', () => queryResult([{ _id: productId }]));
    const insertMany = mock.method(Product.collection, 'insertMany', async () => ({}));
    const response = await call('POST', '/products', { storeId: String(storeId), name: 'Milk' });
    assert.equal(response.status, 409);
    assert.equal(insertMany.mock.callCount(), 0);
  });

  it('blocks deleting products with stock history', async () => {
    mock.method(Product, 'findById', () => queryResult({ _id: productId }));
    mock.method(InventoryItem, 'countDocuments', async () => 0);
    mock.method(DumpedInventory, 'countDocuments', async () => 1);
    const deleteOne = mock.method(Product, 'deleteOne', async () => ({}));
    const response = await call('DELETE', '/products', { storeId: String(storeId), productId: String(productId) });
    assert.equal(response.status, 409);
    assert.equal(deleteOne.mock.callCount(), 0);
  });

  it('upserts stock for a predefined product', async () => {
    mock.method(Product, 'findById', () => queryResult({ _id: productId, name: 'Milk' }));
    let update: Record<string, unknown> = {};
    mock.method(InventoryItem, 'findOneAndUpdate', async (_filter: unknown, value: Record<string, unknown>) => {
      update = value;
      return { _id: itemId, productId, product: 'Milk', quantity: 5, expiryDate: '2026-01-01' };
    });
    const response = await call('POST', `/inventory?storeId=${storeId}`, { productId: String(productId), expiryDate: '2026-01-01', quantity: '5' });
    assert.equal(response.status, 201);
    assert.deepEqual(update.$inc, { quantity: 5 });
  });

  it('enforces first-expiry-first-out when consuming', async () => {
    mock.method(InventoryItem, 'findOne', (query: Record<string, unknown>) => queryResult(
      query._id
        ? { _id: itemId, productId, product: 'Milk', quantity: 3, expiryDate: today(10) }
        : { expiryDate: today(2) },
    ));
    const response = await call('PATCH', `/inventory?storeId=${storeId}`, { action: 'consume', inventoryItemId: String(itemId), quantity: 1 });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { message: string }).message, /earlier expiry/);
  });

  it('dumps expired stock and records the disposal', async () => {
    mock.method(InventoryItem, 'findOne', () => queryResult({ _id: itemId, productId, product: 'Milk', quantity: 3, expiryDate: today(-2) }));
    mock.method(InventoryItem, 'findOneAndUpdate', async () => ({ _id: itemId, productId, product: 'Milk', quantity: 3, expiryDate: today(-2) }));
    const create = mock.method(DumpedInventory, 'create', async () => ({}));
    const response = await call('PATCH', `/inventory?storeId=${storeId}`, { action: 'dump', inventoryItemId: String(itemId) });
    assert.equal(response.status, 200);
    assert.equal((create.mock.calls[0]?.arguments[0] as { quantity: number }).quantity, 3);
  });

  it('rejects dumping stock that has not expired', async () => {
    mock.method(InventoryItem, 'findOne', () => queryResult({ _id: itemId, productId, product: 'Milk', quantity: 3, expiryDate: today(1) }));
    const response = await call('PATCH', `/inventory?storeId=${storeId}`, { action: 'dump', inventoryItemId: String(itemId) });
    assert.equal(response.status, 400);
  });
});
