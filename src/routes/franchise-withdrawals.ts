import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { Withdrawal, type WithdrawalRecord } from '../models/Withdrawal.js';
import { auditMutation, isMoneyAmount, localToday } from '../utils/businessLimits.js';
import { bodyRecord, isFranchiseAdmin, requireStore, stringQuery } from '../utils/franchiseRoute.js';
import { isDateValue } from '../utils/storeAccess.js';
import { exceedsMaxRange } from '../utils/dateUtils.js';

export const MAX_WITHDRAWAL_RESULTS = 1000;

export const franchiseWithdrawalsRouter = Router();
const router = franchiseWithdrawalsRouter;

type WithdrawalInput = Pick<WithdrawalRecord, 'date' | 'amount' | 'type'> & { reason: string };

function validate(body: Record<string, unknown>): { value: WithdrawalInput } | { error: string } {
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

function serialize(item: Pick<WithdrawalRecord, '_id' | 'date' | 'amount' | 'type' | 'reason'>) {
  return { id: String(item._id), date: item.date, amount: item.amount, type: item.type, reason: item.reason ?? '' };
}

router.get('/withdrawals', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const from = stringQuery(request, 'from');
  const to = stringQuery(request, 'to');
  const hasRange = isDateValue(from) && isDateValue(to);
  if ((from !== undefined || to !== undefined) && !hasRange) {
    response.status(400).json({ message: 'from and to must both be valid YYYY-MM-DD dates.' });
    return;
  }
  if (hasRange && (from > to || exceedsMaxRange(from, to))) {
    response.status(400).json({ message: 'Date range must be ordered and span at most 366 days.' });
    return;
  }
  const [withdrawals, totals] = await Promise.all([
    Withdrawal.find({ franchise: storeId, ...(hasRange ? { date: { $gte: from, $lte: to } } : {}) })
      .sort({ date: -1, createdAt: -1 })
      .limit(MAX_WITHDRAWAL_RESULTS)
      .lean(),
    Withdrawal.aggregate<{ _id: string; total: number }>([
      { $match: { franchise: storeId, type: { $in: ['withdrawal', 'repayment'] } } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]),
  ]);
  response.json({
    totalWithdrawals: totals.find((item) => item._id === 'withdrawal')?.total ?? 0,
    totalRepayments: totals.find((item) => item._id === 'repayment')?.total ?? 0,
    withdrawals: withdrawals.map(serialize),
  });
});

router.post('/withdrawals', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const validation = validate(bodyRecord(request));
  if ('error' in validation) { response.status(400).json({ message: validation.error }); return; }
  const created = await Withdrawal.create({
    franchise: storeId,
    ...validation.value,
    createdBy: new mongoose.Types.ObjectId(request.auth!.id),
  });
  auditMutation(request, 'withdrawal.created', { storeId, targetId: created._id, after: validation.value });
  response.status(201).json({ message: 'Entry added successfully.', withdrawal: serialize(created) });
});

router.put('/withdrawals/:id', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const id = String(request.params.id);
  if (!mongoose.isValidObjectId(id)) { response.status(400).json({ message: 'A valid entry id is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const validation = validate(bodyRecord(request));
  if ('error' in validation) { response.status(400).json({ message: validation.error }); return; }
  const previous = await Withdrawal.findOneAndUpdate(
    { _id: id, franchise: storeId },
    { $set: validation.value },
    { new: false },
  ).lean();
  if (!previous) { response.status(404).json({ message: 'Entry not found.' }); return; }
  auditMutation(request, 'withdrawal.updated', { storeId, targetId: id, before: serialize(previous), after: validation.value });
  response.json({ message: 'Entry updated successfully.', withdrawal: serialize({ ...previous, ...validation.value }) });
});

router.delete('/withdrawals/:id', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const id = String(request.params.id);
  if (!mongoose.isValidObjectId(id)) { response.status(400).json({ message: 'A valid entry id is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const deleted = await Withdrawal.findOneAndDelete({ _id: id, franchise: storeId }).lean();
  if (!deleted) { response.status(404).json({ message: 'Entry not found.' }); return; }
  auditMutation(request, 'withdrawal.deleted', { storeId, targetId: id, before: serialize(deleted) });
  response.json({ message: 'Entry removed.' });
});
