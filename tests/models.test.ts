import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Franchise } from '../src/models/Franchise.js';
import { User } from '../src/models/User.js';

describe('Franchise model', () => {
  it('requires a name and store code', () => {
    const error = new Franchise({}).validateSync();

    assert.ok(error);
    assert.ok(error.errors.name);
    assert.ok(error.errors.storeCode);
  });

  it('normalizes codes and defaults stores to active franchises', () => {
    const store = new Franchise({ name: 'Demo Store', storeCode: ' demo-001 ' });

    assert.equal(store.storeCode, 'DEMO-001');
    assert.equal(store.storeType, 'franchise');
    assert.equal(store.isActive, true);
    assert.equal(store.validateSync(), undefined);
  });

  it('rejects unsupported store types', () => {
    const store = new Franchise({ name: 'Demo Store', storeCode: 'DEMO-002', storeType: 'warehouse' });

    assert.ok(store.validateSync()?.errors.storeType);
  });
});

describe('User model', () => {
  it('requires email, password, and name', () => {
    const error = new User({}).validateSync();

    assert.ok(error);
    assert.ok(error.errors.email);
    assert.ok(error.errors.password);
    assert.ok(error.errors.name);
  });

  it('defaults users to active employees without store assignments', () => {
    const user = new User({
      name: 'Demo User',
      email: 'demo@example.test',
      password: 'hashed-password',
    });

    assert.equal(user.role, 'employee');
    assert.equal(user.isActive, true);
    assert.deepEqual(user.franchises, []);
    assert.equal(user.validateSync(), undefined);
  });

  it('rejects unsupported roles', () => {
    const user = new User({
      name: 'Demo User',
      email: 'demo@example.test',
      password: 'hashed-password',
      role: 'owner',
    });

    assert.ok(user.validateSync()?.errors.role);
  });
});
