import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createUserSchema,
  emailSchema,
  firstValidationMessage,
  passwordSchema,
  patchUserSchema,
  profileSchema,
  storeArchiveSchema,
  storeBodySchema,
} from '../src/utils/validation.js';

describe('emailSchema', () => {
  it('trims and lowercases valid email addresses', () => {
    assert.equal(emailSchema.parse('  Demo.User@Example.com  '), 'demo.user@example.com');
  });

  it('rejects malformed email addresses', () => {
    assert.equal(emailSchema.safeParse('not-an-email').success, false);
  });
});

describe('passwordSchema', () => {
  it('accepts passwords that meet the complexity requirements', () => {
    assert.equal(passwordSchema.safeParse('Correct-Horse9!').success, true);
  });

  it('rejects passwords missing a required character class', () => {
    assert.equal(passwordSchema.safeParse('lowercase-only9!').success, false);
    assert.equal(passwordSchema.safeParse('UPPERCASE-ONLY9!').success, false);
    assert.equal(passwordSchema.safeParse('MissingDigits!!').success, false);
    assert.equal(passwordSchema.safeParse('MissingSpecial9').success, false);
  });
});

describe('storeBodySchema', () => {
  it('normalizes store fields and allows blank owner email', () => {
    const result = storeBodySchema.parse({
      name: '  Demo Store  ',
      storeCode: ' demo-101 ',
      phone: '1234567890',
      ownerEmail: '',
      storeType: 'franchise',
    });

    assert.equal(result.name, 'Demo Store');
    assert.equal(result.storeCode, 'DEMO-101');
    assert.equal(result.ownerEmail, undefined);
  });

  it('rejects invalid phone numbers and store types', () => {
    const base = { name: 'Demo Store', storeCode: 'DEMO-101' };
    assert.equal(storeBodySchema.safeParse({ ...base, phone: '12345' }).success, false);
    assert.equal(storeBodySchema.safeParse({ ...base, storeType: 'warehouse' }).success, false);
  });
});

describe('user and profile schemas', () => {
  it('normalizes optional email and phone on create', () => {
    const result = createUserSchema.parse({
      name: 'Demo User',
      email: '  USER@example.test ',
      phone: ' 5551234567 ',
      role: 'franchise_admin',
      franchiseIds: ['store-id'],
    });

    assert.equal(result.email, 'user@example.test');
    assert.equal(result.phone, '5551234567');
  });

  it('rejects invalid role and excessive store assignments', () => {
    assert.equal(createUserSchema.safeParse({ name: 'Demo', role: 'owner' }).success, false);
    assert.equal(createUserSchema.safeParse({
      name: 'Demo',
      franchiseIds: Array.from({ length: 51 }, (_, index) => `store-${index}`),
    }).success, false);
  });

  it('accepts partial user updates and rejects empty names', () => {
    assert.deepEqual(patchUserSchema.parse({ phone: '5551234567' }), { phone: '5551234567' });
    assert.equal(patchUserSchema.safeParse({ name: '  ' }).success, false);
  });

  it('validates archive flags and reports the first validation issue', () => {
    const invalidArchive = storeArchiveSchema.safeParse({ archived: 'yes' });
    assert.equal(invalidArchive.success, false);
    if (!invalidArchive.success) {
      assert.equal(firstValidationMessage(invalidArchive.error), 'Invalid input: expected boolean, received string');
    }

    const invalidProfile = profileSchema.safeParse({ newPassword: 'weak' });
    assert.equal(invalidProfile.success, false);
    if (!invalidProfile.success) {
      assert.equal(firstValidationMessage(invalidProfile.error), 'Password must be at least 12 characters.');
    }
  });
});
