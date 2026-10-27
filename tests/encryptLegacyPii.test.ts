import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { decrypt, encrypt, isEncrypted } from '../src/utils/crypto.js';
import { migrateLegacyPii, planLegacyPiiEncryption, type UsersCollectionLike } from '../src/utils/piiMigration.js';

const originalKey = process.env.FIELD_ENCRYPTION_KEY;
before(() => { process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('hex'); });
after(() => {
  if (originalKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = originalKey;
});

function fakeUsers(docs: Record<string, unknown>[], opts: { concurrentChange?: boolean } = {}) {
  const updates: { filter: Record<string, unknown>; set: Record<string, string> }[] = [];
  const users: UsersCollectionLike = {
    find: () => (async function* () { for (const d of docs) yield { ...d }; })(),
    async updateOne(filter, update) {
      updates.push({ filter, set: update.$set });
      const doc = docs.find((d) => d._id === filter._id);
      const matches = !opts.concurrentChange && doc &&
        Object.entries(filter).every(([k, v]) => k === '_id' || doc[k] === v);
      if (!matches || !doc) return { modifiedCount: 0 };
      Object.assign(doc, update.$set);
      return { modifiedCount: 1 };
    },
  };
  return { users, updates };
}

describe('legacy PII encryption migration', () => {
  it('encrypts plaintext fields and round-trips them', () => {
    const plan = planLegacyPiiEncryption({ aadharNumber: '123412341234', panNumber: 'ABCDE1234F' });
    assert.ok(plan);
    assert.ok(isEncrypted(plan.set.aadharNumber!));
    assert.equal(decrypt(plan.set.aadharNumber!), '123412341234');
    assert.equal(decrypt(plan.set.panNumber!), 'ABCDE1234F');
    assert.deepEqual(plan.guard, { aadharNumber: '123412341234', panNumber: 'ABCDE1234F' });
  });

  it('skips already-encrypted, empty, missing and non-string values', () => {
    assert.equal(planLegacyPiiEncryption({ aadharNumber: encrypt('1'), panNumber: '', bankName: null, bankIfsc: 42 }), null);
    const plan = planLegacyPiiEncryption({ aadharNumber: encrypt('1'), bankName: 'SBI' });
    assert.deepEqual(Object.keys(plan!.set), ['bankName']);
  });

  it('dry run counts but never writes', async () => {
    const docs = [{ _id: 1, aadharNumber: '111122223333', bankName: 'HDFC' }, { _id: 2, panNumber: encrypt('X') }];
    const { users, updates } = fakeUsers(docs);
    const stats = await migrateLegacyPii(users, { dryRun: true });
    assert.equal(updates.length, 0);
    assert.equal(stats.documentsNeedingUpdate, 1);
    assert.equal(stats.documentsUpdated, 0);
    assert.equal(stats.fieldsEncrypted.aadharNumber, 1);
    assert.equal(docs[0].aadharNumber, '111122223333');
    assert.ok(!JSON.stringify(stats).includes('111122223333'));
  });

  it('apply encrypts with a guarded filter and is idempotent on re-run', async () => {
    const docs: Record<string, unknown>[] = [{ _id: 1, aadharNumber: '111122223333', bankName: 'HDFC' }];
    const { users, updates } = fakeUsers(docs);
    const first = await migrateLegacyPii(users, { dryRun: false });
    assert.equal(first.documentsUpdated, 1);
    assert.deepEqual(updates[0].filter, { _id: 1, aadharNumber: '111122223333', bankName: 'HDFC' });
    assert.ok(isEncrypted(docs[0].aadharNumber as string));
    assert.equal(decrypt(docs[0].bankName as string), 'HDFC');
    const second = await migrateLegacyPii(users, { dryRun: false });
    assert.equal(second.documentsNeedingUpdate, 0);
    assert.equal(updates.length, 1);
  });

  it('does not overwrite a document changed concurrently', async () => {
    const { users } = fakeUsers([{ _id: 1, panNumber: 'ABCDE1234F' }], { concurrentChange: true });
    const stats = await migrateLegacyPii(users, { dryRun: false });
    assert.equal(stats.documentsUpdated, 0);
    assert.equal(stats.documentsSkippedConcurrent, 1);
  });

  it('refuses to run without a valid FIELD_ENCRYPTION_KEY', async () => {
    const key = process.env.FIELD_ENCRYPTION_KEY;
    try {
      delete process.env.FIELD_ENCRYPTION_KEY;
      await assert.rejects(migrateLegacyPii(fakeUsers([]).users, { dryRun: true }), /FIELD_ENCRYPTION_KEY/);
      process.env.FIELD_ENCRYPTION_KEY = 'short';
      await assert.rejects(migrateLegacyPii(fakeUsers([]).users, { dryRun: true }), /FIELD_ENCRYPTION_KEY/);
    } finally {
      process.env.FIELD_ENCRYPTION_KEY = key;
    }
  });
});
