import type { Request } from 'express';
import { auditLog } from './audit.js';
import { businessDateValue } from './dateUtils.js';

// Upper bounds keep a single tampered request from corrupting store totals and reports.
export const MAX_MONEY_AMOUNT = 100_000_000;
export const MAX_STOCK_QUANTITY = 1_000_000;
export const MAX_EXTRA_DAYS = 31;

// Business dates before this year are treated as typos (e.g. "0226" for "2026").
export const MIN_BUSINESS_YEAR = 2000;

/** Currency has two decimal places; the tolerance absorbs binary float noise such as 0.1 + 0.2. */
export function hasCurrencyPrecision(value: number): boolean {
  const cents = value * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6;
}

export function isMoneyAmount(value: unknown, { allowZero = true } = {}): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && (allowZero ? value >= 0 : value > 0)
    && value <= MAX_MONEY_AMOUNT
    && hasCurrencyPrecision(value);
}

/** Valid calendar date within the supported business range (year >= MIN_BUSINESS_YEAR). */
export function isBusinessYear(value: string): boolean {
  return Number(value.slice(0, 4)) >= MIN_BUSINESS_YEAR;
}

/** Today's date in the business timezone (Asia/Kolkata), regardless of server timezone. */
export function localToday(): string {
  return businessDateValue();
}

export function auditMutation(
  request: Request,
  action: string,
  details: { storeId?: unknown; targetId?: unknown; before?: unknown; after?: unknown },
): void {
  auditLog(action, {
    actorId: request.auth?.id,
    actorRole: request.auth?.role,
    targetId: details.targetId == null ? undefined : String(details.targetId),
    ip: request.ip,
    metadata: {
      storeId: details.storeId == null ? undefined : String(details.storeId),
      ...(details.before === undefined ? {} : { before: details.before }),
      ...(details.after === undefined ? {} : { after: details.after }),
    },
  });
}
