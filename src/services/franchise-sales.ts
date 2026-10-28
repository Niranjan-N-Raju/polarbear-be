import type { Request, Response } from 'express';
import { withSaleTotals } from '../utils/saleTotals.js';
import { authorizeStore, isDateValue } from '../utils/storeAccess.js';
import { firstValidationMessage, saleBodySchema } from '../utils/validation.js';
export function dateRange(request: Request, response: Response) {
  const from = request.query.from;
  const to = request.query.to;
  if (!isDateValue(from) || !isDateValue(to) || from > to) {
    response.status(400).json({ message: 'A valid date range is required.' });
    return null;
  }
  if (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime() > 366 * 24 * 60 * 60 * 1000) {
    response.status(400).json({ message: 'Date range cannot exceed 366 days.' });
    return null;
  }
  return { from, to };
}
export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown; }).code === 11000;
}
export function saleAuditSnapshot(sale: Record<string, unknown>) {
  const { date, totalSale, swiggy, zomato, upi, upiCharge, cash, expenses, totalExpenses, bankingCash } = sale;
  return { date, totalSale, swiggy, zomato, upi, upiCharge, cash, expenses, totalExpenses, bankingCash };
}
export async function parseSaleRequest(request: Request, response: Response) {
  const parsed = saleBodySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: firstValidationMessage(parsed.error) });
    return null;
  }
  const storeObjectId = await authorizeStore(parsed.data.storeId, request.auth?.id ?? '', response);
  if (!storeObjectId) return null;
  const { storeId: _storeId, ...sale } = parsed.data;
  const cash = sale.totalSale - sale.swiggy - sale.zomato - sale.upi;
  return { storeObjectId, values: withSaleTotals({ ...sale, cash }) };
}
