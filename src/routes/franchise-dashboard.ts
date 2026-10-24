import { Router } from 'express';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { Franchise } from '../models/Franchise.js';
import { Sale } from '../models/Sale.js';
import { User } from '../models/User.js';
import { firstValidationMessage, saleBodySchema } from '../utils/validation.js';
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
    .select('date totalSale swiggy zomato upi upiCharge cash expenses totalExpenses bankingCash')
    .sort({ date: -1 })
    .lean();
  response.json({ sales: sales.map(withSaleTotals) });
});

interface SaleTotalsInput {
  cash?: number;
  upiCharge?: number;
  expenses?: { amount: number }[];
  totalExpenses?: number;
  bankingCash?: number;
}

function withSaleTotals<T extends SaleTotalsInput>(sale: T) {
  const totalExpenses = sale.totalExpenses ?? (sale.expenses ?? []).reduce((sum, expense) => sum + expense.amount, 0);
  return {
    ...sale,
    upiCharge: sale.upiCharge ?? 0,
    totalExpenses,
    bankingCash: sale.bankingCash ?? (sale.cash ?? 0) - totalExpenses,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

async function parseSaleRequest(request: Request, response: Response) {
  const parsed = saleBodySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: firstValidationMessage(parsed.error) });
    return null;
  }
  const storeObjectId = await authorizeStore(parsed.data.storeId, request.auth?.id ?? '', response);
  if (!storeObjectId) return null;
  const { storeId: _storeId, ...sale } = parsed.data;
  const cash = sale.totalSale - sale.swiggy - sale.zomato - sale.upi;
  const totalExpenses = sale.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  return { storeObjectId, values: { ...sale, cash, totalExpenses, bankingCash: cash - totalExpenses } };
}

franchiseDashboardRouter.post('/sales', requireAuth, async (request, response, next) => {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const parsed = await parseSaleRequest(request, response);
  if (!parsed) return;
  if (await Sale.findOne({ franchise: parsed.storeObjectId, date: parsed.values.date }).select('_id').lean()) {
    response.status(409).json({ message: 'A sale already exists for this date.' });
    return;
  }
  try {
    const sale = await Sale.create({
      ...parsed.values,
      franchise: parsed.storeObjectId,
      createdBy: new mongoose.Types.ObjectId(request.auth.id),
    });
    response.status(201).json({ sale, message: 'Sale saved successfully.' });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: 'A sale already exists for this date.' });
      return;
    }
    throw error;
  }
});

franchiseDashboardRouter.put('/sales/:id', requireAuth, async (request, response, next) => {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const saleId = request.params.id;
  if (typeof saleId !== 'string' || !mongoose.isValidObjectId(saleId)) {
    response.status(400).json({ message: 'A valid sale id is required.' });
    return;
  }
  const parsed = await parseSaleRequest(request, response);
  if (!parsed) return;
  const duplicate = await Sale.findOne({
    franchise: parsed.storeObjectId,
    date: parsed.values.date,
    _id: { $ne: new mongoose.Types.ObjectId(saleId) },
  }).select('_id').lean();
  if (duplicate) {
    response.status(409).json({ message: 'A sale already exists for this date.' });
    return;
  }
  try {
    const sale = await Sale.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(saleId), franchise: parsed.storeObjectId },
      { $set: parsed.values },
      { new: true, runValidators: true },
    ).lean();
    if (!sale) {
      response.status(404).json({ message: 'Sale not found.' });
      return;
    }
    response.json({ sale, message: 'Sale updated successfully.' });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ message: 'A sale already exists for this date.' });
      return;
    }
    throw error;
  }
});
