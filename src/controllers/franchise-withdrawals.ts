import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Withdrawal } from '../models/Withdrawal.js';
import { MAX_WITHDRAWAL_RESULTS, serialize, validate } from '../services/franchise-withdrawals.js';
import { auditMutation } from '../utils/businessLimits.js';
import { exceedsMaxRange } from '../utils/dateUtils.js';
import { bodyRecord, isFranchiseAdmin, requireStore, stringQuery } from '../utils/franchiseRoute.js';
import { isDateValue } from '../utils/storeAccess.js';
export async function getWithdrawals(request: Request, response: Response, next: NextFunction) {
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
    // All-time totals intentionally ignore the list's date filter and result limit.
    Withdrawal.aggregate<{ _id: string; total: number; }>([
      { $match: { franchise: storeId, type: { $in: ['withdrawal', 'repayment'] } } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]),
  ]);
  response.json({
    totalWithdrawals: totals.find((item) => item._id === 'withdrawal')?.total ?? 0,
    totalRepayments: totals.find((item) => item._id === 'repayment')?.total ?? 0,
    withdrawals: withdrawals.map(serialize),
  });
}

export async function postWithdrawals(request: Request, response: Response, next: NextFunction) {
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
}

export async function putWithdrawalsId(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const id = String(request.params.id);
  if (!mongoose.isValidObjectId(id)) { response.status(400).json({ message: 'A valid entry id is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const validation = validate(bodyRecord(request));
  if ('error' in validation) { response.status(400).json({ message: validation.error }); return; }
  // Scope the mutation to the authorized store and retain the pre-update document for the audit.
  const previous = await Withdrawal.findOneAndUpdate(
    { _id: id, franchise: storeId },
    { $set: validation.value },
    { new: false },
  ).lean();
  if (!previous) { response.status(404).json({ message: 'Entry not found.' }); return; }
  auditMutation(request, 'withdrawal.updated', { storeId, targetId: id, before: serialize(previous), after: validation.value });
  response.json({ message: 'Entry updated successfully.', withdrawal: serialize({ ...previous, ...validation.value }) });
}

export async function deleteWithdrawalsId(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const id = String(request.params.id);
  if (!mongoose.isValidObjectId(id)) { response.status(400).json({ message: 'A valid entry id is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const deleted = await Withdrawal.findOneAndDelete({ _id: id, franchise: storeId }).lean();
  if (!deleted) { response.status(404).json({ message: 'Entry not found.' }); return; }
  auditMutation(request, 'withdrawal.deleted', { storeId, targetId: id, before: serialize(deleted) });
  response.json({ message: 'Entry removed.' });
}
