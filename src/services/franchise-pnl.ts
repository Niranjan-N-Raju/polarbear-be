import { isMoneyAmount } from '../utils/businessLimits.js';
import { PNL_EXPENSE_KEYS } from '../utils/pnlExpenses.js';
export const MAX_MONTHS = 36;
export const MAX_PERIOD_WALK = 1200;
export const MAX_FIELDS = 200;
export const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,49}$/;
export type PeriodType = 'calendar_month' | 'custom';
export type ValueMap = Record<string, number>;
export function monthValue(date: Date) {
  return formatPeriod(date.getFullYear(), date.getMonth() + 1);
}
function formatPeriod(year: number, month: number) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}
/** Adds months to a YYYY-MM period with plain year/month arithmetic (no Date day overflow). */
export function addMonthsToPeriod(period: string, months: number) {
  const [year, month] = period.split('-').map(Number);
  const index = year * 12 + (month - 1) + months;
  return formatPeriod(Math.floor(index / 12), (index % 12) + 1);
}
export function periodForDate(dateStr: string, cycleType: PeriodType, startDay: number) {
  const period = dateStr.slice(0, 7);
  if (cycleType === 'calendar_month') return period;
  const day = Number(dateStr.slice(8, 10));
  // Match salary-cycle labels: a custom cycle is named for the month in which it ends.
  return day >= startDay ? addMonthsToPeriod(period, 1) : period;
}
export function nextPeriod(period: string) {
  return addMonthsToPeriod(period, 1);
}
export function toPlainValues(values: unknown): ValueMap {
  if (values instanceof Map) return Object.fromEntries(values) as ValueMap;
  return (values as ValueMap | null | undefined) ?? {};
}
export function finiteNonNegative(value: unknown): value is number {
  return isMoneyAmount(value);
}
export const ALLOWED_INPUT_KEYS = new Set<string>(['netSales', 'nob', ...PNL_EXPENSE_KEYS]);
