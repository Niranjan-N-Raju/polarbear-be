import { isMoneyAmount } from '../utils/businessLimits.js';
import { PNL_EXPENSE_KEYS } from '../utils/pnlExpenses.js';
export const MAX_MONTHS = 36;
export const MAX_PERIOD_WALK = 1200;
export const MAX_FIELDS = 200;
export const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,49}$/;
export type PeriodType = 'calendar_month' | 'custom';
export type ValueMap = Record<string, number>;
export function monthValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
export function periodForDate(dateStr: string, cycleType: PeriodType, startDay: number) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (cycleType === 'calendar_month') return monthValue(date);
  const shifted = new Date(date);
  // Match salary-cycle labels: a custom cycle is named for the month in which it ends.
  if (date.getDate() >= startDay) shifted.setMonth(shifted.getMonth() + 1);
  return monthValue(shifted);
}
export function nextPeriod(period: string) {
  const [year, month] = period.split('-').map(Number);
  return monthValue(new Date(year, month, 1));
}
export function toPlainValues(values: unknown): ValueMap {
  if (values instanceof Map) return Object.fromEntries(values) as ValueMap;
  return (values as ValueMap | null | undefined) ?? {};
}
export function finiteNonNegative(value: unknown): value is number {
  return isMoneyAmount(value);
}
export const ALLOWED_INPUT_KEYS = new Set<string>(['netSales', 'nob', ...PNL_EXPENSE_KEYS]);
