import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { queryResult, setupFranchiseApi, storeId, otherStoreId } from './helpers/franchiseApi.js';

const call = setupFranchiseApi();
const employeeId = new mongoose.Types.ObjectId();

describe('franchise employees API', () => {
  it('scopes employee listing to authorized store and supports search, status, and pagination', async () => {
    let filter: Record<string, unknown> = {};
    mock.method(User, 'find', (query: Record<string, unknown>) => {
      filter = query;
      return queryResult([{ _id: employeeId, name: 'Asha', email: 'emp@example.test', role: 'employee', franchises: [storeId] }]);
    });
    mock.method(User, 'countDocuments', async () => 1);
    const response = await call('GET', `/users?storeId=${storeId}&search=Asha&status=active&page=2&limit=9`);
    assert.equal(response.status, 200);
    assert.equal(filter.role, 'employee');
    assert.equal(String(filter.franchises), String(storeId));
    assert.equal(filter.isActive && typeof filter.isActive === 'object' ? (filter.isActive as { $ne: boolean }).$ne : undefined, false);
    assert.deepEqual(filter.$or?.constructor, Array);
    const body = await response.json() as { users: Array<{ _id: string }>; pagination: { page: number; limit: number; total: number } };
    assert.equal(body.users[0]._id, String(employeeId));
    assert.deepEqual(body.pagination, { page: 2, limit: 9, total: 1, totalPages: 1 });
  });

  it('rejects an inaccessible store', async () => {
    const response = await call('GET', `/users?storeId=${otherStoreId}`);
    assert.equal(response.status, 403);
  });

  it('creates employees assigned only to the current store', async () => {
    let created: Record<string, unknown> = {};
    mock.method(User, 'create', async (input: Record<string, unknown>) => {
      created = input;
      return { _id: employeeId, employeeCode: input.employeeCode };
    });
    const response = await call('POST', '/users', { storeId: String(storeId), franchiseIds: [String(storeId)], name: 'New employee' });
    assert.equal(response.status, 201);
    assert.deepEqual(created.franchises, [storeId]);
    assert.equal(created.role, 'employee');
    assert.equal(created.employeeCode, 'EMP0001');
    const body = await response.json() as { user: { _id: string; employeeCode: string } };
    assert.equal(body.user._id, String(employeeId));
    assert.equal(body.user.employeeCode, 'EMP0001');
    const next = await call('POST', '/users', { storeId: String(storeId), name: 'Another employee', employeeCode: 'EMP9999' });
    assert.equal(next.status, 201);
    assert.equal(created.employeeCode, 'EMP0002');
    assert.equal((await next.json() as { user: { employeeCode: string } }).user.employeeCode, 'EMP0002');
  });

  it('validates employee payloads and rejects cross-store assignment', async () => {
    const missingName = await call('POST', '/users', { storeId: String(storeId), name: ' ' });
    assert.equal(missingName.status, 400);
    assert.equal((await missingName.json() as { message: string }).message, 'Name is required.');
    const foreignAssignment = await call('POST', '/users', { storeId: String(storeId), franchiseIds: [String(otherStoreId)], name: 'Asha' });
    assert.equal(foreignAssignment.status, 403);
  });

  it('records a salary hike atomically while retaining the original baseline', async () => {
    const employee = { _id: employeeId, role: 'employee', franchises: [storeId], salary: 3100, isActive: true, salaryRevisions: [] };
    mock.method(User, 'findOne', () => queryResult(employee));
    let update: Record<string, any> = {};
    mock.method(User, 'findOneAndUpdate', (filter: Record<string, unknown>, values: Record<string, any>) => {
      assert.equal(filter.salary, 3100);
      update = values;
      return queryResult({ ...employee, salary: 6200 });
    });
    const response = await call('POST', `/users/${employeeId}/salary-hikes?storeId=${storeId}`, { salary: 6200, effectiveFrom: '2026-01-16' });
    assert.equal(response.status, 200);
    assert.deepEqual(update.$set, { salary: 6200, salaryBaseline: 3100 });
    assert.equal(update.$push.salaryRevisions.effectiveFrom, '2026-01-16');
    assert.equal(update.$push.salaryRevisions.salary, 6200);
  });

  it('rejects lower salaries, duplicate effective dates, archived staff, and stale hikes', async () => {
    const employee = { _id: employeeId, role: 'employee', franchises: [storeId], salary: 6200, salaryBaseline: 3100, isActive: true, salaryRevisions: [{ effectiveFrom: '2026-01-16', salary: 6200 }] };
    mock.method(User, 'findOne', () => queryResult(employee));
    const update = mock.method(User, 'findOneAndUpdate', () => queryResult(null));
    const path = `/users/${employeeId}/salary-hikes?storeId=${storeId}`;
    assert.equal((await call('POST', path, { salary: 5000, effectiveFrom: '2026-02-01' })).status, 400);
    assert.equal((await call('POST', path, { salary: 9000, effectiveFrom: '2026-01-16' })).status, 400);
    assert.equal((await call('PATCH', `/users/${employeeId}?storeId=${storeId}`, { salary: 9000 })).status, 400);
    assert.equal(update.mock.callCount(), 0);
    employee.isActive = false;
    assert.equal((await call('POST', path, { salary: 9000, effectiveFrom: '2026-02-01' })).status, 400);
    employee.isActive = true;
    assert.equal((await call('POST', path, { salary: 9000, effectiveFrom: '2026-02-01' })).status, 409);
  });

  it('updates and archives/restores employees', async () => {
    const target = {
      _id: employeeId, name: 'Asha', role: 'employee', franchises: [storeId], isActive: true, sessionVersion: 0,
      async save() { return this; },
      toObject() { return { _id: this._id, name: this.name, role: this.role, franchises: this.franchises, isActive: this.isActive }; },
    };
    mock.method(User, 'findOne', () => queryResult(target));
    const patched = await call('PATCH', `/users/${employeeId}?storeId=${storeId}`, { name: 'Asha Updated', phone: '1234567890' });
    assert.equal(patched.status, 200);
    assert.equal(target.name, 'Asha Updated');
    const archived = await call('DELETE', `/users/${employeeId}?storeId=${storeId}`, { exitDate: '2026-01-03' });
    assert.equal(archived.status, 200);
    assert.equal(target.isActive, false);
    const restored = await call('PUT', `/users/${employeeId}?storeId=${storeId}`);
    assert.equal(restored.status, 200);
    assert.equal(target.isActive, true);
  });

  it('rejects invalid document types and malformed upload payloads', async () => {
    const invalidType = await call('POST', `/users/${employeeId}/documents/passport?storeId=${storeId}`, {});
    assert.equal(invalidType.status, 400);
    const invalidPayload = await call('POST', `/users/${employeeId}/documents/aadhar?storeId=${storeId}`, { base64: 'not base64' });
    assert.equal(invalidPayload.status, 400);
  });
});
