import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { Attendance } from '../src/models/Attendance.js';
import { Franchise } from '../src/models/Franchise.js';
import { User } from '../src/models/User.js';
import { WeeklyRoster } from '../src/models/WeeklyRoster.js';
import { otherStoreId, queryResult, setupFranchiseApi, storeId, userId } from './helpers/franchiseApi.js';

let archived = false;
const call = setupFranchiseApi({ franchise: () => (archived ? { isActive: false, archivedAt: new Date() } : { isActive: true }) });

function mockEmployeeQueries() {
  const finds: unknown[] = [];
  mock.method(User, 'find', (filter: unknown) => { finds.push(filter); return queryResult([]); });
  mock.method(User, 'countDocuments', async () => 0);
  return finds;
}

describe('independent review: employee store resolution (Express 5 req.query)', () => {
  it('honours the franchiseId query alias for an assigned store', async () => {
    const finds = mockEmployeeQueries();
    const response = await call('GET', `/users?franchiseId=${storeId}`);
    assert.equal(response.status, 200);
    assert.equal(String((finds[0] as { franchises: unknown }).franchises), String(storeId));
  });

  it('falls back to the caller\'s own assigned store when no store is supplied', async () => {
    const finds = mockEmployeeQueries();
    const response = await call('GET', '/users');
    assert.equal(response.status, 200);
    assert.equal(String((finds[0] as { franchises: unknown }).franchises), String(storeId));
  });

  it('rejects a foreign store supplied through the franchiseId alias', async () => {
    const finds = mockEmployeeQueries();
    const response = await call('GET', `/users?franchiseId=${otherStoreId}`);
    assert.equal(response.status, 403);
    assert.equal(finds.length, 0);
  });

  it('rejects a foreign store supplied through body.franchiseIds on create', async () => {
    const create = mock.method(User, 'create', async () => { throw new Error('must not be called'); });
    const response = await call('POST', '/users', { name: 'Mallory', franchiseIds: [String(otherStoreId)] });
    assert.equal(response.status, 403);
    assert.equal(create.mock.callCount(), 0);
  });

  it('rejects a non-string store id instead of coercing it', async () => {
    mockEmployeeQueries();
    const response = await call('POST', '/users', { name: 'Mallory', storeId: { $ne: null } });
    assert.ok([400, 403].includes(response.status));
  });
});

describe('independent review: attendance GET has no side effects on archived stores', () => {
  function mockAttendance() {
    mock.method(WeeklyRoster, 'find', () => queryResult([{
      createdBy: userId,
      entries: [{ employee: userId, days: [{ date: '2025-01-01', shift: 'morning' }] }],
    }]));
    mock.method(Attendance, 'find', () => queryResult([]));
    return mock.method(Attendance, 'bulkWrite', async () => ({}));
  }

  it('does not materialize roster defaults for an archived store', async () => {
    archived = true;
    try {
      mock.method(Franchise, 'findById', () => queryResult({ _id: storeId, isActive: false, archivedAt: new Date() }));
      const bulkWrite = mockAttendance();
      const response = await call('GET', `/attendance?storeId=${storeId}&from=2025-01-01&to=2025-01-07`);
      assert.equal(response.status, 200);
      assert.equal(bulkWrite.mock.callCount(), 0);
    } finally {
      archived = false;
    }
  });

  it('still materializes roster defaults for an active store', async () => {
    mock.method(Franchise, 'findById', () => queryResult({ _id: storeId, isActive: true }));
    const bulkWrite = mockAttendance();
    const response = await call('GET', `/attendance?storeId=${storeId}&from=2025-01-01&to=2025-01-07`);
    assert.equal(response.status, 200);
    assert.equal(bulkWrite.mock.callCount(), 1);
  });
});

describe('independent review: field encryption integrity', () => {
  it('rejects ciphertext whose GCM auth tag has been truncated', async () => {
    const previous = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    try {
      const { decrypt, encrypt, decryptBuffer, encryptBuffer } = await import('../src/utils/crypto.js');
      const stored = encrypt('ABCDE1234F');
      assert.equal(decrypt(stored), 'ABCDE1234F');
      const [iv, tag, ct] = stored.slice(4).split('.');
      const shortTag = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
      assert.throws(() => decrypt(`enc:${iv}.${shortTag}.${ct}`));

      const blob = encryptBuffer(Buffer.from('%PDF-1.4 test'));
      assert.equal(decryptBuffer(blob).toString(), '%PDF-1.4 test');
      const truncated = Buffer.concat([blob.subarray(0, 16), blob.subarray(28)]);
      assert.throws(() => decryptBuffer(truncated));
    } finally {
      if (previous === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
      else process.env.FIELD_ENCRYPTION_KEY = previous;
    }
  });
});
