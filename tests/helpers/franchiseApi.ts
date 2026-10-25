import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { after, afterEach, before, beforeEach, mock } from 'node:test';
import mongoose from 'mongoose';
import { app } from '../../src/app.js';
import { Franchise } from '../../src/models/Franchise.js';
import { User } from '../../src/models/User.js';
import { signSessionToken } from '../../src/utils/token.js';

export const userId = new mongoose.Types.ObjectId();
export const storeId = new mongoose.Types.ObjectId();
export const otherStoreId = new mongoose.Types.ObjectId();

export function queryResult(value: unknown) {
  return {
    select() { return this; },
    sort() { return this; },
    populate() { return this; },
    limit() { return this; },
    skip() { return this; },
    lean: async () => value,
    then(resolve: (input: unknown) => unknown, reject?: (error: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

export function setupFranchiseApi(options: { franchise?: () => Record<string, unknown> } = {}) {
  const state = { url: '', token: '' };
  let server: Server;
  const previousSecret = process.env.JWT_SECRET;

  before(async () => {
    process.env.JWT_SECRET = 'unit-test-only-not-a-production-secret';
    state.token = await signSessionToken({ id: String(userId), name: 'Test', email: 'test@example.test', role: 'franchise_admin' });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    state.url = `http://127.0.0.1:${address.port}/api`;
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
    mock.method(Franchise, 'find', () => queryResult([{ _id: storeId, ...(options.franchise?.() ?? {}) }]));
  });
  afterEach(() => mock.restoreAll());

  return async function call(method: string, path: string, body?: unknown) {
    return fetch(`${state.url}${path}`, {
      method,
      headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
}
