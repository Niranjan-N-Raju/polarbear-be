import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { Sale } from '../src/models/Sale.js';
import { Withdrawal } from '../src/models/Withdrawal.js';
import { DumpedInventory, InventoryItem, Product } from '../src/models/Inventory.js';
import { PnlInput } from '../src/models/PnlInput.js';
import { Franchise } from '../src/models/Franchise.js';
import { User } from '../src/models/User.js';
import { Advance } from '../src/models/Advance.js';
import { ExtraDay } from '../src/models/ExtraDay.js';
import { Incentive } from '../src/models/Incentive.js';
import { Attendance } from '../src/models/Attendance.js';
import { MAX_MONEY_AMOUNT, MAX_STOCK_QUANTITY } from '../src/utils/businessLimits.js';
import { otherStoreId, queryResult, setupFranchiseApi, storeId, userId } from './helpers/franchiseApi.js';

const call = setupFranchiseApi();
const productId = new mongoose.Types.ObjectId();
const itemId = new mongoose.Types.ObjectId();
const employeeId = new mongoose.Types.ObjectId();

const validSale = {
  storeId: String(storeId), date: '2026-01-15', totalSale: 1000, swiggy: 100, zomato: 50, upi: 300, upiCharge: 5,
  expenses: [{ name: 'Milk', amount: 120 }],
};

function dateOffset(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function captureAudit() {
  const events: Record<string, unknown>[] = [];
  mock.method(console, 'log', (line: unknown) => {
    if (typeof line === 'string' && line.startsWith('[AUDIT] ')) events.push(JSON.parse(line.slice(8)) as Record<string, unknown>);
  });
  return events;
}

async function message(response: Response) {
  return ((await response.json()) as { message: string }).message;
}

describe('business logic: sales tampering', () => {
  it('ignores client-supplied computed totals and ownership fields', async () => {
    let created: Record<string, unknown> | undefined;
    mock.method(Sale, 'findOne', () => queryResult(null));
    mock.method(Sale, 'create', async (doc: Record<string, unknown>) => { created = doc; return { _id: 'sale-1', ...doc }; });
    const response = await call('POST', '/sales', {
      ...validSale, cash: 999999, totalExpenses: 0, bankingCash: 999999,
      franchise: String(otherStoreId), createdBy: String(new mongoose.Types.ObjectId()),
    });
    assert.equal(response.status, 201);
    assert.ok(created);
    assert.equal(created.cash, 550);
    assert.equal(created.totalExpenses, 120);
    assert.equal(created.bankingCash, 430);
    assert.equal(String(created.franchise), String(storeId));
    assert.equal(String(created.createdBy), String(userId));
  });

  it('rejects channel splits larger than the total sale (negative cash)', async () => {
    const create = mock.method(Sale, 'create', async () => ({}));
    mock.method(Sale, 'findOne', () => queryResult(null));
    const response = await call('POST', '/sales', { ...validSale, swiggy: 800, zomato: 100, upi: 300 });
    assert.equal(response.status, 400);
    assert.match(await message(response), /cannot exceed the total sale/);
    assert.equal(create.mock.callCount(), 0);
  });

  it('rejects overflow amounts that would corrupt reports', async () => {
    const create = mock.method(Sale, 'create', async () => ({}));
    mock.method(Sale, 'findOne', () => queryResult(null));
    for (const body of [
      { ...validSale, totalSale: MAX_MONEY_AMOUNT + 1 },
      { ...validSale, totalSale: 1e308 },
      { ...validSale, expenses: [{ name: 'Milk', amount: MAX_MONEY_AMOUNT + 1 }] },
    ]) {
      assert.equal((await call('POST', '/sales', body)).status, 400);
    }
    assert.equal(create.mock.callCount(), 0);
  });

  it('turns a concurrent duplicate-day race into a single sale plus 409', async () => {
    let stored = 0;
    mock.method(Sale, 'findOne', () => queryResult(null));
    mock.method(Sale, 'create', async (doc: Record<string, unknown>) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (stored > 0) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      stored += 1;
      return { _id: 'sale-1', ...doc };
    });
    const statuses = (await Promise.all([call('POST', '/sales', validSale), call('POST', '/sales', validSale)])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(stored, 1);
  });

  it('cannot update a sale belonging to another store and audits real updates', async () => {
    const saleId = new mongoose.Types.ObjectId();
    const events = captureAudit();
    mock.method(Sale, 'findOne', () => queryResult(null));
    let filter: Record<string, unknown> = {};
    mock.method(Sale, 'findOneAndUpdate', (query: Record<string, unknown>) => {
      filter = query;
      return queryResult(String(query.franchise) === String(storeId) ? { _id: saleId, totalSale: 500, date: '2026-01-15' } : null);
    });
    assert.equal((await call('PUT', `/sales/${saleId}`, { ...validSale, storeId: String(otherStoreId) })).status, 403);
    const updated = await call('PUT', `/sales/${saleId}`, validSale);
    assert.equal(updated.status, 200);
    assert.equal(String(filter.franchise), String(storeId));
    const event = events.find((item) => item.action === 'sale.updated');
    assert.ok(event);
    assert.equal(event.actorId, String(userId));
    const metadata = event.metadata as { before: { totalSale: number }; after: { totalSale: number } };
    assert.equal(metadata.before.totalSale, 500);
    assert.equal(metadata.after.totalSale, 1000);
  });
});

describe('business logic: withdrawals', () => {
  it('rejects future-dated, zero, negative and overflow withdrawals', async () => {
    const create = mock.method(Withdrawal, 'create', async () => ({}));
    const base = { storeId: String(storeId), type: 'withdrawal' };
    const future = await call('POST', '/withdrawals', { ...base, date: dateOffset(1), amount: 10 });
    assert.equal(future.status, 400);
    assert.equal(await message(future), 'Date cannot be in the future.');
    for (const amount of [0, -5, MAX_MONEY_AMOUNT + 1, '100', null]) {
      assert.equal((await call('POST', '/withdrawals', { ...base, date: '2026-01-01', amount })).status, 400);
    }
    assert.equal(create.mock.callCount(), 0);
  });

  it('scopes updates to the caller store and audits the before/after values', async () => {
    const entryId = new mongoose.Types.ObjectId();
    const events = captureAudit();
    mock.method(Withdrawal, 'findOneAndUpdate', (query: Record<string, unknown>) => queryResult(
      String(query.franchise) === String(storeId) ? { _id: entryId, date: '2026-01-02', amount: 50, type: 'withdrawal', reason: '' } : null,
    ));
    const response = await call('PUT', `/withdrawals/${entryId}`, { storeId: String(storeId), date: '2026-01-02', amount: 75, type: 'withdrawal' });
    assert.equal(response.status, 200);
    const event = events.find((item) => item.action === 'withdrawal.updated');
    assert.ok(event);
    const metadata = event.metadata as { before: { amount: number }; after: { amount: number } };
    assert.equal(metadata.before.amount, 50);
    assert.equal(metadata.after.amount, 75);
  });
});

describe('business logic: salary entries', () => {
  it('rejects overflow amounts and impossible extra days', async () => {
    const creates = [
      mock.method(Advance, 'create', async () => ({})),
      mock.method(Incentive, 'create', async () => ({})),
      mock.method(ExtraDay, 'create', async () => ({})),
    ];
    const base = { storeId: String(storeId), employeeId: String(employeeId), period: '2026-01', type: 'Cash' };
    for (const [path, extra] of [
      ['/advances', { amount: MAX_MONEY_AMOUNT + 1 }], ['/advances', { amount: -1 }], ['/advances', { amount: Infinity }],
      ['/incentives', { amount: 1e308 }],
      ['/extra-days', { days: 32 }], ['/extra-days', { days: 100000 }], ['/extra-days', { days: -1 }],
    ] as const) {
      assert.equal((await call('POST', path, { ...base, ...extra })).status, 400, `${path} ${JSON.stringify(extra)}`);
    }
    for (const create of creates) assert.equal(create.mock.callCount(), 0);
  });

  it('does not allow attaching entries to employees outside the store', async () => {
    const create = mock.method(Advance, 'create', async () => ({}));
    mock.method(User, 'findOne', () => queryResult(null));
    const response = await call('POST', '/advances', { storeId: String(storeId), employeeId: String(employeeId), period: '2026-01', type: 'Cash', amount: 100 });
    assert.equal(response.status, 404);
    assert.equal(create.mock.callCount(), 0);
  });
});

describe('business logic: P&L inputs', () => {
  it('rejects unknown keys and overflow values', async () => {
    mock.method(Franchise, 'exists', async () => ({ _id: storeId }));
    const update = mock.method(PnlInput, 'findOneAndUpdate', () => queryResult({ period: '2026-10', values: new Map() }));
    const unknown = await call('PUT', '/pnl/inputs', { storeId: String(storeId), period: '2026-10', values: { netSalesOverride: 5 } });
    assert.equal(unknown.status, 400);
    assert.equal(await message(unknown), 'Invalid field name: netSalesOverride.');
    const overflow = await call('PUT', '/pnl/inputs', { storeId: String(storeId), period: '2026-10', values: { rent: MAX_MONEY_AMOUNT + 1 } });
    assert.equal(overflow.status, 400);
    assert.equal(update.mock.callCount(), 0);
  });
});

describe('business logic: inventory integrity', () => {
  it('rejects absurd stock quantities', async () => {
    mock.method(Product, 'findById', () => queryResult({ _id: productId, name: 'Milk' }));
    const update = mock.method(InventoryItem, 'findOneAndUpdate', async () => ({}));
    for (const quantity of [MAX_STOCK_QUANTITY + 1, String(MAX_STOCK_QUANTITY + 1), '1e9', 1.5, -3]) {
      const response = await call('POST', `/inventory?storeId=${storeId}`, { productId: String(productId), expiryDate: dateOffset(5), quantity });
      assert.equal(response.status, 400, `quantity ${quantity}`);
    }
    assert.equal(update.mock.callCount(), 0);
  });

  it('cannot consume or dump stock from another store', async () => {
    let filter: Record<string, unknown> = {};
    mock.method(InventoryItem, 'findOne', (query: Record<string, unknown>) => { filter = query; return queryResult(null); });
    const response = await call('PATCH', `/inventory?storeId=${storeId}`, { action: 'consume', inventoryItemId: String(itemId), quantity: 1 });
    assert.equal(response.status, 404);
    assert.equal(filter.storeId, String(storeId));
    assert.equal((await call('PATCH', `/inventory?storeId=${otherStoreId}`, { action: 'dump', inventoryItemId: String(itemId) })).status, 403);
  });

  it('never oversells when two consume requests race for the last units', async () => {
    const stock = { quantity: 5 };
    const events = captureAudit();
    mock.method(InventoryItem, 'findOne', (query: Record<string, unknown>) => queryResult(
      query._id ? { _id: itemId, productId, product: 'Milk', quantity: stock.quantity, expiryDate: dateOffset(10) } : null,
    ));
    // Emulates MongoDB's atomic conditional update: the guard and decrement happen together.
    mock.method(InventoryItem, 'findOneAndUpdate', async (query: { quantity: { $gte: number } }, update: { $inc: { quantity: number } }) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (stock.quantity < query.quantity.$gte) return null;
      stock.quantity += update.$inc.quantity;
      return { _id: itemId, productId, product: 'Milk', quantity: stock.quantity, expiryDate: dateOffset(10) };
    });
    const body = { action: 'consume', inventoryItemId: String(itemId), quantity: 4 };
    const responses = await Promise.all([
      call('PATCH', `/inventory?storeId=${storeId}`, body),
      call('PATCH', `/inventory?storeId=${storeId}`, body),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
    assert.equal(stock.quantity, 1);
    assert.equal(events.filter((item) => item.action === 'inventory.stock.consumed').length, 1);
  });

  it('records a single dump when expired stock is dumped twice concurrently', async () => {
    const stock = { quantity: 7 };
    mock.method(InventoryItem, 'findOne', () => queryResult({ _id: itemId, productId, product: 'Milk', quantity: 7, expiryDate: dateOffset(-2) }));
    mock.method(InventoryItem, 'findOneAndUpdate', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (stock.quantity <= 0) return null;
      const before = { _id: itemId, productId, product: 'Milk', quantity: stock.quantity, expiryDate: dateOffset(-2) };
      stock.quantity = 0;
      return before;
    });
    const dumped = mock.method(DumpedInventory, 'create', async () => ({}));
    const body = { action: 'dump', inventoryItemId: String(itemId) };
    const responses = await Promise.all([
      call('PATCH', `/inventory?storeId=${storeId}`, body),
      call('PATCH', `/inventory?storeId=${storeId}`, body),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(dumped.mock.callCount(), 1);
    assert.equal((dumped.mock.calls[0]?.arguments[0] as { quantity: number }).quantity, 7);
  });

  it('refuses to dump unexpired stock or consume expired stock', async () => {
    mock.method(InventoryItem, 'findOne', () => queryResult({ _id: itemId, productId, product: 'Milk', quantity: 3, expiryDate: dateOffset(3) }));
    const dump = await call('PATCH', `/inventory?storeId=${storeId}`, { action: 'dump', inventoryItemId: String(itemId) });
    assert.equal(dump.status, 400);
    mock.method(InventoryItem, 'findOne', () => queryResult({ _id: itemId, productId, product: 'Milk', quantity: 3, expiryDate: dateOffset(-1) }));
    const consume = await call('PATCH', `/inventory?storeId=${storeId}`, { action: 'consume', inventoryItemId: String(itemId), quantity: 1 });
    assert.equal(consume.status, 400);
  });
});

describe('business logic: attendance', () => {
  it('ignores records for employees outside the store and audits saved marks', async () => {
    const events = captureAudit();
    const foreign = new mongoose.Types.ObjectId();
    mock.method(User, 'find', () => queryResult([{ _id: employeeId, isActive: true, dateOfJoining: new Date('2025-01-01') }]));
    let operations: unknown[] = [];
    mock.method(Attendance, 'bulkWrite', async (ops: unknown[]) => { operations = ops; });
    const response = await call('PUT', '/attendance', {
      storeId: String(storeId), date: '2026-01-05',
      records: [{ employeeId: String(employeeId), status: 'Present' }, { employeeId: String(foreign), status: 'Present' }],
    });
    assert.equal(response.status, 200);
    assert.equal(operations.length, 1);
    const event = events.find((item) => item.action === 'attendance.marked');
    assert.ok(event);
    const records = (event.metadata as { after: { records: { employeeId: string }[] } }).after.records;
    assert.deepEqual(records.map((record) => String(record.employeeId)), [String(employeeId)]);
  });
});
