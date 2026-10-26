import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { queryResult, setupFranchiseApi, userId } from './helpers/franchiseApi.js';

const call = setupFranchiseApi();

describe('logout revocation', () => {
  it('rejects reuse and extension of a logged-out bearer token', async () => {
    let sessionVersion = 0;
    mock.method(User, 'findById', () => queryResult({
      _id: userId, role: 'franchise_admin', isActive: true, sessionVersion,
    }));
    const updateOne = mock.fn(async (filter: unknown, update: unknown) => {
      assert.deepEqual(filter, { _id: userId });
      assert.deepEqual(update, { $inc: { sessionVersion: 1 } });
      sessionVersion += 1;
      return { matchedCount: 1 };
    });
    mock.method(mongoose.connection, 'collection', () => ({ updateOne }));

    assert.equal((await call('POST', '/auth/logout')).status, 200);
    assert.equal(updateOne.mock.callCount(), 1);
    assert.equal((await call('GET', '/inventory')).status, 401);
    assert.equal((await call('POST', '/auth/extend')).status, 401);
    assert.equal((await call('POST', '/auth/logout')).status, 401);
    assert.equal(updateOne.mock.callCount(), 1);
  });

  it('does not report successful logout when revocation fails', async () => {
    mock.method(mongoose.connection, 'collection', () => ({
      updateOne: async () => { throw new Error('simulated database failure'); },
    }));
    const response = await call('POST', '/auth/logout');
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /simulated database failure/);
  });

  it('does not renew a session revoked after authentication but before extension', async () => {
    mock.method(mongoose.connection, 'collection', () => ({
      findOne: async () => ({ _id: userId, role: 'franchise_admin', sessionVersion: 1 }),
    }));
    assert.equal((await call('POST', '/auth/extend')).status, 401);
  });
});
