import type { Request } from 'express';
import { auditLog } from './audit.js';

// Upper bounds keep a single tampered request from corrupting store totals and reports.
export const MAX_MONEY_AMOUNT = 100_000_000;
export const MAX_STOCK_QUANTITY = 1_000_000;
export const MAX_EXTRA_DAYS = 31;

export function isMoneyAmount(value: unknown, { allowZero = true } = {}): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && (allowZero ? value >= 0 : value > 0)
    && value <= MAX_MONEY_AMOUNT;
}

export function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
