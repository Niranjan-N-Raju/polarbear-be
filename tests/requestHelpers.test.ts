import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeRegex } from '../src/utils/listQuery.js';
import { bodyTooLarge } from '../src/utils/requestBody.js';

describe('shared request helpers', () => {
  it('escapes every regex metacharacter without changing literal searches', () => {
    const search = 'store.*+?^${}()|[]\\ ಕನ್ನಡ';
    const pattern = new RegExp(`^${escapeRegex(search)}$`);
    assert.equal(pattern.test(search), true);
    assert.equal(pattern.test('store-anything'), false);
  });

  it('preserves independent store and user byte limits, including exact boundaries', () => {
    for (const limit of [10_000, 50_000]) {
      assert.equal(bodyTooLarge({ text: 'a'.repeat(limit - 11) }, limit), false);
      assert.equal(bodyTooLarge({ text: 'a'.repeat(limit - 10) }, limit), true);
    }
  });

  it('measures encoded bytes instead of character count and handles absent bodies', () => {
    assert.equal(bodyTooLarge({ text: 'é' }, 12), true);
    assert.equal(bodyTooLarge(undefined, 2), false);
    assert.equal(bodyTooLarge(null, 2), false);
  });
});
