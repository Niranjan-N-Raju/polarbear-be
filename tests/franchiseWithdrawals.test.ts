import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { Withdrawal } from '../src/models/Withdrawal.js';
import { otherStoreId, queryResult, setupFranchiseApi, storeId } from './helpers/franchiseApi.js';

const call = setupFranchiseApi();
const entryId = new mongoose.Types.ObjectId();

describe('franchise withdrawals API', () => {
  it('rejects stores the franchise admin cannot access', async () => {
    const response = await call('GET', `/withdrawals?storeId=${otherStoreId}`);
    assert.equal(response.status, 403);
  });

  it('lists entries in range with all-time totals', async () => {
    let filter: Record<string, unknown> = {};
    mock.method(Withdrawal, 'find', (query: Record<string, unknown>) => {
      filter = query;
      return queryResult([{ _id: entryId, date: '2026-01-05', amount: 500, type: 'withdrawal', reason: 'Rent' }]);
    });
    mock.method(Withdrawal, 'aggregate', async () => [{ _id: 'withdrawal', total: 900 }, { _id: 'repayment', total: 200 }]);
    const response = await call('GET', `/withdrawals?storeId=${storeId}&from=2026-01-01&to=2026-01-31`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.totalWithdrawals, 900);
    assert.equal(body.totalRepayments, 200);
    assert.deepEqual(body.withdrawals, [{ id: String(entryId), date: '2026-01-05', amount: 500, type: 'withdrawal', reason: 'Rent' }]);
    assert.deepEqual(filter.date, { $gte: '2026-01-01', $lte: '2026-01-31' });
  });

  it('validates payloads in order', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ amount: 5, type: 'withdrawal' }, 'A valid date is required.'],
      [{ date: '2026-01-01', amount: 0, type: 'withdrawal' }, 'A valid amount is required.'],
      [{ date: '2026-01-01', amount: 5, type: 'loan' }, 'Type must be either withdrawal or repayment.'],
      [{ date: '2026-01-01', amount: 5, type: 'repayment', reason: 'x'.repeat(301) }, 'Reason must be 300 characters or fewer.'],
    ];
    for (const [body, message] of cases) {
      const response = await call('POST', '/withdrawals', { storeId: String(storeId), ...body });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { message: string }).message, message);
    }
  });

  it('creates, updates and deletes entries', async () => {
    mock.method(Withdrawal, 'create', async (doc: Record<string, unknown>) => ({ _id: entryId, ...doc }));
    const created = await call('POST', '/withdrawals', { storeId: String(storeId), date: '2026-01-02', amount: 100, type: 'repayment', reason: ' Back ' });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { withdrawal: { reason: string } }).withdrawal.reason, 'Back');

    mock.method(Withdrawal, 'findOneAndUpdate', () => queryResult(null));
    const missing = await call('PUT', `/withdrawals/${entryId}`, { storeId: String(storeId), date: '2026-01-02', amount: 100, type: 'repayment' });
    assert.equal(missing.status, 404);

    mock.method(Withdrawal, 'findOneAndDelete', () => queryResult({ _id: entryId }));
    const removed = await call('DELETE', `/withdrawals/${entryId}?storeId=${storeId}`);
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { message: string }).message, 'Entry removed.');
  });
});
