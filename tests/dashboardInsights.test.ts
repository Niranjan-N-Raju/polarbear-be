import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeExpenseBreakdown,
  computeMonthlyAttrition,
  computePaymentMixTrend,
  computeWeekdayPerformance,
  type SaleInsight,
} from '../src/utils/dashboardInsights.js';

const sales: SaleInsight[] = [
  { date: '2026-10-04', totalSale: 1000, swiggy: 100, zomato: 200, upi: 400, cash: 300, expenses: [{ name: 'Milk', amount: 50 }] },
  { date: '2026-10-11', totalSale: 2000, swiggy: 200, zomato: 400, upi: 800, cash: 600, expenses: [{ name: 'Milk', amount: 25 }, { name: 'Rent', amount: 100 }] },
];

describe('dashboard insights migrated from Next.js', () => {
  it('averages recorded days, groups expenses, and calculates payment shares', () => {
    assert.deepEqual(computeWeekdayPerformance(sales)[0], { day: 'Sun', average: 1500 });
    assert.deepEqual(computeWeekdayPerformance(sales)[1], { day: 'Mon', average: 0 });
    assert.deepEqual(computeExpenseBreakdown(sales), [{ name: 'Rent', amount: 100 }, { name: 'Milk', amount: 75 }]);
    assert.deepEqual(computeExpenseBreakdown(sales, 1), [{ name: 'Rent', amount: 100 }]);
    assert.deepEqual(computePaymentMixTrend(sales), [{
      month: '2026-10', monthLabel: 'Oct 2026', onlinePercent: 30, upiPercent: 40, cashPercent: 30,
    }]);
  });

  it('returns defined empty-state results, limits categories, and orders recorded months', () => {
    assert.equal(computeWeekdayPerformance([]).length, 7);
    assert.deepEqual(computeExpenseBreakdown([]), []);
    assert.deepEqual(computePaymentMixTrend([]), []);
    assert.equal(computeExpenseBreakdown([{
      ...sales[0], expenses: Array.from({ length: 10 }, (_, index) => ({ name: String(index), amount: index })),
    }]).length, 8);
    assert.deepEqual(computePaymentMixTrend([
      { ...sales[0], date: '2026-10-01' },
      { ...sales[0], date: '2026-08-01' },
      { ...sales[0], date: '2026-09-01', totalSale: 0 },
    ], 2).map((month) => [month.month, month.onlinePercent]), [['2026-09', 0], ['2026-10', 30]]);
  });

  it('uses the day before archive as exit day and the starting headcount for attrition', () => {
    const result = computeMonthlyAttrition([
      { dateOfJoining: '2026-01-01', archivedAt: '2026-10-01' },
      { dateOfJoining: '2026-01-01' },
      { dateOfJoining: '2026-10-05' },
      {},
    ], new Date('2026-10-24T00:00:00Z'));
    assert.equal(result.length, 6);
    assert.deepEqual(result[4], { month: '2026-09', monthLabel: 'Sept 2026', headcount: 2, leavers: 1, rate: 50 });
    assert.deepEqual(result[5], { month: '2026-10', monthLabel: 'Oct 2026', headcount: 1, leavers: 0, rate: 0 });
  });
});
