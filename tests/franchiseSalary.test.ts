import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { Advance } from '../src/models/Advance.js';
import { Attendance } from '../src/models/Attendance.js';
import { ExtraDay } from '../src/models/ExtraDay.js';
import { Franchise } from '../src/models/Franchise.js';
import { Incentive } from '../src/models/Incentive.js';
import { User } from '../src/models/User.js';
import { otherStoreId, queryResult, setupFranchiseApi, storeId, userId } from './helpers/franchiseApi.js';

const call = setupFranchiseApi({ franchise: () => ({ salaryCycleType: 'calendar_month', salaryCycleStartDay: 1, salaryCycleEndDay: 31 }) });
const employeeId = new mongoose.Types.ObjectId();
const advanceId = new mongoose.Types.ObjectId();

describe('franchise salary API', () => {
  it('rejects stores the franchise admin cannot access and invalid periods', async () => {
    assert.equal((await call('GET', `/salary?storeId=${otherStoreId}&period=2026-01`)).status, 403);
    assert.equal((await call('GET', `/salary?storeId=${storeId}&period=2026-13`)).status, 400);
  });

  it('projects earnings using cycle attendance, extra days, incentives and advances', async () => {
    mock.method(Franchise, 'findById', () => queryResult({ _id: storeId, name: 'North', salaryCycleType: 'calendar_month', salaryCycleStartDay: 1, salaryCycleEndDay: 31 }));
    mock.method(User, 'find', () => queryResult([{ _id: employeeId, name: 'Ada', salary: 3100, position: 'Chef', isActive: true, dateOfJoining: new Date('2026-01-01T00:00:00Z') }]));
    mock.method(Attendance, 'find', () => queryResult([
      { employee: employeeId, date: '2026-01-02', status: 'Present' },
      { employee: employeeId, date: '2026-01-03', status: 'Week Off' },
    ]));
    mock.method(Incentive, 'find', () => queryResult([{ _id: new mongoose.Types.ObjectId(), employee: employeeId, type: 'Sales', amount: 100 }]));
    mock.method(ExtraDay, 'find', () => queryResult([{ _id: new mongoose.Types.ObjectId(), employee: employeeId, type: 'Comp Off', days: 1 }]));
    mock.method(Advance, 'find', () => queryResult([{ _id: advanceId, employee: employeeId, type: 'Cash Advance', amount: 250 }]));
    const response = await call('GET', `/salary?storeId=${storeId}&period=2026-01`);
    assert.equal(response.status, 200);
    const body = await response.json() as { cycle: { totalDays: number }; projections: Array<Record<string, any>> };
    assert.equal(body.cycle.totalDays, 31);
    assert.equal(body.projections[0].paidDays, 2);
    assert.equal(body.projections[0].earnedSalary, 150);
    assert.equal(body.projections[0].projectedSalary, 150);
    assert.equal(body.projections[0].advanceTotal, 250);
  });

  it('creates entries only for employees in the authorized store and supports updates/deletes', async () => {
    mock.method(User, 'findOne', () => queryResult({ _id: employeeId }));
    mock.method(Advance, 'create', async (doc: Record<string, unknown>) => ({ _id: advanceId, employee: employeeId, ...doc }));
    const created = await call('POST', '/advances', { storeId: String(storeId), employeeId: String(employeeId), period: '2026-01', type: ' Emergency ', amount: 100 });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { advance: { type: string } }).advance.type, 'Emergency');

    mock.method(Advance, 'findById', () => ({ franchise: storeId, _id: advanceId, save: async () => undefined }));
    const updated = await call('PUT', `/advances/${advanceId}`, { storeId: String(storeId), type: 'Loan', amount: 120 });
    assert.equal(updated.status, 200);

    mock.method(Advance, 'findOneAndDelete', () => queryResult({ _id: advanceId }));
    const removed = await call('DELETE', `/advances/${advanceId}?storeId=${storeId}`);
    assert.equal(removed.status, 200);
  });
});
