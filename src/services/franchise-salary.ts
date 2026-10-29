import mongoose from 'mongoose';
import { Advance } from '../models/Advance.js';
import { ExtraDay } from '../models/ExtraDay.js';
import { Incentive } from '../models/Incentive.js';
import { isMoneyAmount, MAX_EXTRA_DAYS } from '../utils/businessLimits.js';
export type EntryKind = 'advance' | 'incentive' | 'extraDay';
export const collections: Record<EntryKind, mongoose.Model<any>> = { advance: Advance, incentive: Incentive, extraDay: ExtraDay };
export const labels = { advance: 'Advance', incentive: 'Incentive', extraDay: 'Extra days' } as const;
export function id(value: unknown) { return value == null ? '' : String(value); }
export function number(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
export function groupByEmployee<T extends { employee: unknown; }>(items: T[]) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = id(item.employee);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}
export function validateEntry(body: Record<string, unknown>, kind: EntryKind): { error: string; value?: never; } | { value: Record<string, unknown>; error?: never; } {
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  if (!type || type.length > 100) return { error: `Enter a ${kind === 'advance' ? 'reason for the advance' : kind === 'incentive' ? 'incentive type' : 'reason for the extra days'}.` } as const;
  const value = kind === 'extraDay' ? body.days : body.amount;
  const valid = kind === 'extraDay'
    ? typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_EXTRA_DAYS
    : isMoneyAmount(value);
  if (!valid) return { error: kind === 'extraDay' ? `Enter a valid number of days (0 to ${MAX_EXTRA_DAYS}).` : 'Enter a valid amount.' } as const;
  if (kind === 'incentive' && body.paidEarly !== undefined && typeof body.paidEarly !== 'boolean') return { error: 'Paid early must be true or false.' };
  return { value: { type, [kind === 'extraDay' ? 'days' : 'amount']: value, ...(kind === 'incentive' && body.paidEarly !== undefined ? { paidEarly: body.paidEarly } : {}) } };
}
export function serializeEntry(item: any, kind: EntryKind) {
  return { id: id(item._id), employeeId: id(item.employee), type: item.type, ...(kind === 'extraDay' ? { days: number(item.days) } : { amount: number(item.amount) }), ...(kind === 'incentive' ? { paidEarly: item.paidEarly === true } : {}) };
}