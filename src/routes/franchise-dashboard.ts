import { Router } from 'express';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { Franchise } from '../models/Franchise.js';
import { Sale } from '../models/Sale.js';
import { User } from '../models/User.js';
import {
  computeExpenseBreakdown,
  computeMonthlyAttrition,
  computePaymentMixTrend,
  computeWeekdayPerformance,
} from '../utils/dashboardInsights.js';

export const franchiseDashboardRouter = Router();

function isDateValue(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function getVisibleStoreIds(userId: string): Promise<string[]> {
  const user = await User.findById(userId).select('franchises').lean();
  if (!user) return [];
  const assignedIds = (user.franchises ?? []).map(String);
  const stores = await Franchise.find({
    $or: [{ createdBy: new mongoose.Types.ObjectId(userId) }, { _id: { $in: assignedIds } }],
  })
    .select('_id')
    .lean();
  return stores.map((store) => String(store._id));
}

async function authorizeStore(
  storeId: unknown,
  userId: string,
  response: Response,
): Promise<mongoose.Types.ObjectId | null> {
  if (typeof storeId !== 'string' || !mongoose.isValidObjectId(storeId)) {
    response.status(400).json({ message: 'A valid storeId is required.' });
    return null;
  }
  const visibleIds = await getVisibleStoreIds(userId);
  if (!visibleIds.includes(storeId)) {
    response.status(403).json({ message: 'Access denied to this store.' });
    return null;
  }
  return new mongoose.Types.ObjectId(storeId);
}

function dateRange(request: Request, response: Response) {
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

franchiseDashboardRouter.get('/stores', requireAuth, async (request, response, next) => {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const visibleIds = await getVisibleStoreIds(request.auth.id);
  const franchises = visibleIds.length
    ? await Franchise.find({ _id: { $in: visibleIds } })
      .select('_id name address storeCode isActive archivedAt')
      .sort({ name: 1 })
      .lean()
    : [];
  response.json({ franchises });
});

franchiseDashboardRouter.get('/dashboard', requireAuth, async (request, response, next) => {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const storeObjectId = await authorizeStore(request.query.storeId, request.auth.id, response);
  if (!storeObjectId) return;

  const storeCount = (await getVisibleStoreIds(request.auth.id)).length;
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthFrom = `${monthPrefix}-01`;
  const monthTo = `${monthPrefix}-${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}`;
  const [employeeSummary, monthlySales, employees, sales] = await Promise.all([
    User.countDocuments({
      franchises: storeObjectId,
      role: 'employee',
      isActive: { $ne: false },
    }),
    Sale.aggregate([
      { $match: { franchise: storeObjectId, date: { $gte: monthFrom, $lte: monthTo } } },
      { $group: { _id: null, total: { $sum: '$totalSale' } } },
    ]),
    User.find({ franchises: storeObjectId, role: 'employee' })
      .select('dateOfJoining archivedAt isActive')
      .lean(),
    Sale.find({ franchise: storeObjectId })
      .select('date totalSale swiggy zomato upi cash expenses')
      .lean(),
  ]);

  response.json({
    storeCount,
    employeeSummary,
    salesSummary: monthlySales[0]?.total ?? 0,
    attendanceSummary: 0,
    attritionTrend: computeMonthlyAttrition(employees),
    weekdayPerformance: computeWeekdayPerformance(sales),
    expenseBreakdown: computeExpenseBreakdown(sales),
    paymentMixTrend: computePaymentMixTrend(sales),
  });
});

franchiseDashboardRouter.get('/sales', requireAuth, async (request, response, next) => {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const storeObjectId = await authorizeStore(request.query.storeId, request.auth.id, response);
  if (!storeObjectId) return;
  const range = dateRange(request, response);
  if (!range) return;

  const sales = await Sale.find({
    franchise: storeObjectId,
    date: { $gte: range.from, $lte: range.to },
  })
    .select('date totalSale')
    .sort({ date: 1 })
    .lean();
  response.json({ sales });
});
