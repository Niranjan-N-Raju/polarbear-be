import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { Advance } from '../src/models/Advance.js';
import { Attendance } from '../src/models/Attendance.js';
import { ExtraDay } from '../src/models/ExtraDay.js';
import { Franchise } from '../src/models/Franchise.js';
import { Incentive } from '../src/models/Incentive.js';
import { PnlInput } from '../src/models/PnlInput.js';
import { Sale } from '../src/models/Sale.js';
import { User } from '../src/models/User.js';
import { businessDateValue } from '../src/utils/dateUtils.js';
import { queryResult, setupFranchiseApi, storeId, otherStoreId, userId } from './helpers/franchiseApi.js';

const call = setupFranchiseApi();
const employeeId = new mongoose.Types.ObjectId();

describe('franchise P&L API', () => {
  it('rejects stores the franchise admin cannot access', async () => {
    const response = await call('GET', `/pnl?storeId=${otherStoreId}`);
    assert.equal(response.status, 403);
  });

  it('returns an empty month list when the store has no sales', async () => {
    mock.method(Franchise, 'findById', () => queryResult({ _id: storeId, name: 'Test Store' }));
    mock.method(Sale, 'findOne', () => queryResult(null));
    const response = await call('GET', `/pnl?storeId=${storeId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      store: { id: String(storeId), name: 'Test Store' },
      months: [],
    });
  });

  it('calculates the month with payroll and manual P&L inputs in the Next response shape', async () => {
    const today = businessDateValue();
    const period = today.slice(0, 7);
    const daysInCycle = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();
    // Earned salary plus incentives; the 500 advance is a cash-flow item and must not reduce P&L payroll.
    const expectedPayroll = Math.round((30_000 * 2 / daysInCycle + 200) * 100) / 100;

    mock.method(Franchise, 'findById', () => queryResult({
      _id: storeId, name: 'Test Store', salaryCycleType: 'calendar_month', salaryCycleStartDay: 1, salaryCycleEndDay: 31,
    }));
    mock.method(Sale, 'findOne', () => queryResult({ date: `${period}-01` }));
    mock.method(Sale, 'find', () => queryResult([
      { date: today, totalSale: 10_000, totalExpenses: 2_000, swiggy: 400, zomato: 600 },
    ]));
    mock.method(User, 'find', () => queryResult([
      { _id: employeeId, salary: 30_000, isActive: true },
    ]));
    mock.method(Attendance, 'find', () => queryResult([
      { employee: employeeId, date: today, status: 'Present' },
    ]));
    mock.method(Incentive, 'find', () => queryResult([
      { employee: employeeId, period, amount: 200 },
    ]));
    mock.method(ExtraDay, 'find', () => queryResult([
      { employee: employeeId, period, days: 1 },
    ]));
    mock.method(Advance, 'find', () => queryResult([
      { employee: employeeId, period, amount: 500 },
    ]));
    mock.method(PnlInput, 'find', () => queryResult([
      { period, values: new Map([['netSales', 1_000], ['food', 50], ['rent', 100], ['telephoneCharges', 25]]) },
    ]));

    const response = await call('GET', `/pnl?storeId=${storeId}`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      store: { id: string; name: string };
      cycle: { type: string; startDay: number };
      months: Array<Record<string, number | string | boolean>>;
    };
    assert.deepEqual(body.store, { id: String(storeId), name: 'Test Store' });
    assert.deepEqual(body.cycle, { type: 'calendar_month', startDay: 1 });
    assert.equal(body.months.length, 1);
    assert.deepEqual(body.months[0], {
      period,
      from: `${period}-01`,
      to: `${period}-${String(daysInCycle).padStart(2, '0')}`,
      revenue: 10_000,
      netSales: 1_000,
      grossProfit: 950,
      salesExpenses: 2_000,
      storeExpenses: 125,
      payroll: expectedPayroll,
      totalExpenses: 125 + expectedPayroll,
      netProfit: 950 - 125 - expectedPayroll,
      margin: ((950 - 125 - expectedPayroll) / 1_000) * 100,
      swiggyRevenue: 400,
      zomatoRevenue: 600,
      isCurrent: true,
    });
  });

  it('validates and saves monthly input values', async () => {
    const bad = await call('PUT', '/pnl/inputs', { storeId: String(storeId), period: '2026-13', values: {} });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as { message: string }).message, 'A valid period is required.');

    const invalidValue = await call('PUT', '/pnl/inputs', {
      storeId: String(storeId), period: '2026-10', values: { rent: -1 },
    });
    assert.equal(invalidValue.status, 400);
    assert.equal((await invalidValue.json() as { message: string }).message, 'Enter a valid value for rent.');

    let updateFilter: Record<string, unknown> = {};
    let updatePayload: Record<string, unknown> = {};
    mock.method(Franchise, 'exists', async () => ({ _id: storeId }));
    mock.method(PnlInput, 'findOne', () => queryResult({ period: '2026-10', values: new Map([['rent', 100], ['food', 40]]) }));
    mock.method(PnlInput, 'findOneAndUpdate', (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      updateFilter = filter;
      updatePayload = update;
      return queryResult({ period: '2026-10', values: new Map([['rent', 300]]) });
    });
    const saved = await call('PUT', '/pnl/inputs', {
      storeId: String(storeId), period: '2026-10', values: { rent: 300 },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(updateFilter, { franchise: storeId, period: '2026-10' });
    // Values merge per key so fields not sent (food) are preserved.
    assert.deepEqual(updatePayload.$set, { 'values.rent': 300 });
    assert.deepEqual(await saved.json(), {
      message: 'P&L inputs saved.', input: { period: '2026-10', values: { rent: 300 } },
    });
  });

  it('returns saved inputs by store and period', async () => {
    mock.method(PnlInput, 'findOne', () => queryResult({ period: '2026-10', values: new Map([['rent', 300]]) }));
    const response = await call('GET', `/pnl/inputs?storeId=${storeId}&period=2026-10`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input: { period: '2026-10', values: { rent: 300 } } });
  });
});
