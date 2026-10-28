import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withSaleTotals } from '../src/utils/saleTotals.js';

describe('shared sale totals', () => {
  it('derives missing totals without mutating the source or losing other fields', () => {
    const sale = { date: '2026-01-15', cash: 550, expenses: [{ amount: 120 }, { amount: 30 }] };
    const result = withSaleTotals(sale);
    assert.deepEqual(result, { ...sale, upiCharge: 0, totalExpenses: 150, bankingCash: 400 });
    assert.equal('totalExpenses' in sale, false);
  });

  it('preserves stored totals, including zero and negative banking cash', () => {
    assert.deepEqual(
      withSaleTotals({ cash: 100, expenses: [{ amount: 50 }], upiCharge: 5, totalExpenses: 0, bankingCash: 0 }),
      { cash: 100, expenses: [{ amount: 50 }], upiCharge: 5, totalExpenses: 0, bankingCash: 0 },
    );
    assert.equal(withSaleTotals({ cash: 10, expenses: [{ amount: 20 }] }).bankingCash, -10);
  });

  it('handles legacy records with no optional fields', () => {
    assert.deepEqual(withSaleTotals({}), { upiCharge: 0, totalExpenses: 0, bankingCash: 0 });
  });
});
