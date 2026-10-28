import { type WithdrawalRecord } from '../models/Withdrawal.js';
import { isMoneyAmount,localToday } from '../utils/businessLimits.js';
import { isDateValue } from '../utils/storeAccess.js';
export const MAX_WITHDRAWAL_RESULTS = 1000;
export type WithdrawalInput = Pick<WithdrawalRecord, 'date' | 'amount' | 'type'> & { reason: string };
export function validate(body: Record<string, unknown>): { value: WithdrawalInput } | { error: string } {
  if (!isDateValue(body.date)) return { error: 'A valid date is required.' };
  if (body.date > localToday()) return { error: 'Date cannot be in the future.' };
  const amount = body.amount;
  if (!isMoneyAmount(amount, { allowZero: false })) {
    return { error: 'A valid amount is required.' };
  }
  if (body.type !== 'withdrawal' && body.type !== 'repayment') {
    return { error: 'Type must be either withdrawal or repayment.' };
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > 300) return { error: 'Reason must be 300 characters or fewer.' };
  return { value: { date: body.date, amount, type: body.type, reason } };
}
export function serialize(item: Pick<WithdrawalRecord, '_id' | 'date' | 'amount' | 'type' | 'reason'>) {
  return { id: String(item._id), date: item.date, amount: item.amount, type: item.type, reason: item.reason ?? '' };
}
