import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { Attendance } from '../src/models/Attendance.js';
import { Franchise } from '../src/models/Franchise.js';
import { User } from '../src/models/User.js';
import { WeeklyRoster } from '../src/models/WeeklyRoster.js';
import { otherStoreId, queryResult, setupFranchiseApi, storeId } from './helpers/franchiseApi.js';

const call = setupFranchiseApi({ franchise: () => ({ shifts: [{ id: 'day', name: 'Day', startTime: '09:00', endTime: '18:00' }] }) });
const employeeId = new mongoose.Types.ObjectId();
const attendanceId = new mongoose.Types.ObjectId();

describe('franchise attendance API', () => {
  it('rejects stores the franchise admin cannot access', async () => {
    const response = await call('GET', `/attendance?storeId=${otherStoreId}&date=2026-01-01`);
    assert.equal(response.status, 403);
  });

  it('lists attendance records in date range and applies roster defaults', async () => {
    let findFilter: Record<string, unknown> | undefined;
    mock.method(Franchise, 'findById', () => queryResult({ _id: storeId, isActive: true }));
    mock.method(WeeklyRoster, 'find', () => queryResult([{ createdBy: new mongoose.Types.ObjectId(), entries: [{ employee: employeeId, days: [{ date: '2026-01-05', shift: 'off' }] }] }]));
    mock.method(Attendance, 'bulkWrite', async (operations: unknown[]) => { assert.equal(operations.length, 1); });
    mock.method(Attendance, 'find', (filter: Record<string, unknown>) => { findFilter = filter; return queryResult([{ employee: employeeId, date: '2026-01-05', status: 'Week Off' }]); });
    const response = await call('GET', `/attendance?storeId=${storeId}&from=2026-01-01&to=2026-01-31`);
    assert.equal(response.status, 200);
    assert.deepEqual(findFilter?.date, { $gte: '2026-01-01', $lte: '2026-01-31' });
    assert.deepEqual((await response.json() as { records: unknown[] }).records, [{ employeeId: String(employeeId), date: '2026-01-05', status: 'Week Off', comment: '' }]);
  });

  it('validates and upserts attendance, skipping employees not active on the requested date', async () => {
    const response1 = await call('PUT', '/attendance', { storeId: String(storeId), date: '2026-01-05', records: [{ employeeId: 'bad', status: 'Present' }] });
    assert.equal(response1.status, 400);
    mock.method(User, 'find', () => queryResult([{ _id: employeeId, isActive: true, dateOfJoining: new Date('2025-01-01') }]));
    mock.method(Attendance, 'bulkWrite', async (operations: Array<{ updateOne: { update: { $set: Record<string, unknown> } } }>) => {
      assert.equal(operations.length, 1);
      assert.equal(operations[0].updateOne.update.$set.status, 'Present');
      assert.equal(operations[0].updateOne.update.$set.comment, 'shift');
    });
    const response2 = await call('PUT', '/attendance', { storeId: String(storeId), date: '2026-01-05', records: [{ employeeId: String(employeeId), status: 'Present', comment: ' shift ' }, { employeeId: String(new mongoose.Types.ObjectId()), status: 'Absent' }] });
    assert.equal(response2.status, 200);
    assert.equal((await response2.json() as { skippedCount: number }).skippedCount, 1);
  });

  it('removes one attendance record and returns not found when absent', async () => {
    mock.method(Attendance, 'findOneAndDelete', () => queryResult({ _id: attendanceId }));
    const removed = await call('DELETE', `/attendance?storeId=${storeId}&date=2026-01-05&employeeId=${employeeId}`);
    assert.equal(removed.status, 200);
    mock.method(Attendance, 'findOneAndDelete', () => queryResult(null));
    const missing = await call('DELETE', `/attendance?storeId=${storeId}&date=2026-01-05&employeeId=${employeeId}`);
    assert.equal(missing.status, 404);
  });

  it('gets weekly roster with configured shifts and validates Monday schedules', async () => {
    mock.method(WeeklyRoster, 'find', () => queryResult([{ weekStart: '2026-01-05', entries: [{ employee: employeeId, days: [{ date: '2026-01-05', shift: 'day' }] }] }]));
    mock.method(Franchise, 'findById', () => queryResult({ shifts: [{ id: 'day', name: 'Day', startTime: '09:00', endTime: '18:00' }] }));
    const response = await call('GET', `/attendance/weekly-roster?storeId=${storeId}&weekStart=2026-01-05`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { roster: { entries: Array<{ days: Array<{ shiftName: string }> }> } };
    assert.equal(payload.roster.entries[0].days[0].shiftName, 'Day');
    const invalid = await call('PUT', '/attendance/weekly-roster', { storeId: String(storeId), weekStart: '2026-01-06', entries: [] });
    assert.equal(invalid.status, 400);
  });

  it('saves a valid weekly roster', async () => {
    mock.method(Franchise, 'findById', () => queryResult({ shifts: [{ id: 'day', name: 'Day', startTime: '09:00', endTime: '18:00' }] }));
    mock.method(User, 'find', () => queryResult([{ _id: employeeId, isActive: true, dateOfJoining: new Date('2025-01-01') }]));
    mock.method(WeeklyRoster, 'findOneAndUpdate', () => queryResult({}));
    const dates = Array.from({ length: 7 }, (_, index) => `2026-01-${String(index + 5).padStart(2, '0')}`);
    const response = await call('PUT', '/attendance/weekly-roster', { storeId: String(storeId), weekStart: '2026-01-05', entries: [{ employeeId: String(employeeId), days: dates.map((date) => ({ date, shift: 'day' })) }] });
    assert.equal(response.status, 200);
  });
});
