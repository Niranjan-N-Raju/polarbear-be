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
      return { _id: employeeId };
    });
    const response = await call('POST', '/users', { storeId: String(storeId), franchiseIds: [String(storeId)], name: 'New employee' });
    assert.equal(response.status, 201);
    assert.deepEqual(created.franchises, [storeId]);
    assert.equal(created.role, 'employee');
    assert.equal((await response.json() as { user: { _id: string } }).user._id, String(employeeId));
  });

  it('validates employee payloads and rejects cross-store assignment', async () => {
    const missingName = await call('POST', '/users', { storeId: String(storeId), name: ' ' });
    assert.equal(missingName.status, 400);
    assert.equal((await missingName.json() as { message: string }).message, 'Name is required.');
    const foreignAssignment = await call('POST', '/users', { storeId: String(storeId), franchiseIds: [String(otherStoreId)], name: 'Asha' });
    assert.equal(foreignAssignment.status, 403);
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
