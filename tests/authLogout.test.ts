import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { queryResult, setupFranchiseApi, userId } from './helpers/franchiseApi.js';
import { signSessionToken } from '../src/utils/token.js';

const call = setupFranchiseApi();

describe('browser session restoration', () => {
  async function browserRequest(method: string, token?: string, untrusted = false) {
    const greeting = await call('GET', '/greet');
    const origin = new URL(greeting.url).origin;
    return fetch(`${origin}/api/auth/session`, {
      method,
      headers: {
        Origin: untrusted ? 'https://untrusted.example.test' : origin,
        'X-Web-Session': '1',
        ...(token ? { Cookie: `pb_web_session=${token}` } : {}),
      },
    });
  }

  async function sessionToken() {
    return signSessionToken({
      id: String(userId), name: 'Test', email: 'test@example.test', role: 'franchise_admin',
    });
  }

  it('restores a valid cookie session with current profile information', async () => {
    const token = await sessionToken();
    mock.method(mongoose.connection, 'collection', () => ({
      findOne: async () => ({
        _id: userId, name: 'Updated name', email: 'test@example.test',
        role: 'franchise_admin', sessionVersion: 0, preferredLanguage: 'kn',
      }),
    }));
    const response = await browserRequest('POST', token);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.token, token);
    assert.equal(body.user.name, 'Updated name');
    assert.equal(body.user.preferredLanguage, 'kn');
  });

  it('rejects missing cookies, invalid tokens, and untrusted origins', async () => {
    assert.equal((await browserRequest('POST')).status, 401);
    assert.equal((await browserRequest('POST', 'invalid')).status, 401);
    assert.equal((await browserRequest('POST', await sessionToken(), true)).status, 403);
    assert.equal((await call('POST', '/auth/session')).status, 403);
  });

  it('rejects revoked cookies', async () => {
    mock.method(User, 'findById', () => queryResult({
      _id: userId, role: 'franchise_admin', isActive: true, sessionVersion: 1,
    }));
    assert.equal((await browserRequest('POST', await sessionToken())).status, 401);
  });

  it('allows restoration when a password change is mandatory', async () => {
    mock.method(User, 'findById', () => queryResult({
      _id: userId, role: 'franchise_admin', isActive: true, sessionVersion: 0, mustChangePassword: true,
    }));
    mock.method(mongoose.connection, 'collection', () => ({
      findOne: async () => ({
        _id: userId, name: 'Test', role: 'franchise_admin', sessionVersion: 0, mustChangePassword: true,
      }),
    }));
    const response = await browserRequest('POST', await sessionToken());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.mustChangePassword, true);
  });

  it('clears only the HTTP-only auth cookie on local browser sign-out', async () => {
    const response = await browserRequest('DELETE');
    assert.equal(response.status, 204);
    assert.match(response.headers.get('set-cookie') ?? '', /pb_web_session=;/);
    assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.match(response.headers.get('set-cookie') ?? '', /Path=\/api\/auth/);
    assert.equal((await browserRequest('DELETE', undefined, true)).status, 403);
  });
});

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
