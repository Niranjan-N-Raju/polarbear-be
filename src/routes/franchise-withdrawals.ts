import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { Withdrawal, type WithdrawalRecord } from '../models/Withdrawal.js';
import { bodyRecord, isFranchiseAdmin, requireStore, stringQuery } from '../utils/franchiseRoute.js';
import { isDateValue } from '../utils/storeAccess.js';

export const franchiseWithdrawalsRouter = Router();
const router = franchiseWithdrawalsRouter;

type WithdrawalInput = Pick<WithdrawalRecord, 'date' | 'amount' | 'type'> & { reason: string };

function validate(body: Record<string, unknown>): { value: WithdrawalInput } | { error: string } {
  if (!isDateValue(body.date)) return { error: 'A valid date is required.' };
  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
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
  const [withdrawals, totals] = await Promise.all([
    Withdrawal.find({ franchise: storeId, ...(hasRange ? { date: { $gte: from, $lte: to } } : {}) })
      .sort({ date: -1, createdAt: -1 })
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
  const updated = await Withdrawal.findOneAndUpdate(
    { _id: id, franchise: storeId },
    { $set: validation.value },
    { new: true },
  ).lean();
  if (!updated) { response.status(404).json({ message: 'Entry not found.' }); return; }
  response.json({ message: 'Entry updated successfully.', withdrawal: serialize(updated) });
});

router.delete('/withdrawals/:id', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const id = String(request.params.id);
  if (!mongoose.isValidObjectId(id)) { response.status(400).json({ message: 'A valid entry id is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const deleted = await Withdrawal.findOneAndDelete({ _id: id, franchise: storeId }).lean();
  if (!deleted) { response.status(404).json({ message: 'Entry not found.' }); return; }
  response.json({ message: 'Entry removed.' });
});
