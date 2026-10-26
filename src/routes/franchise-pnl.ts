import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { Advance } from '../models/Advance.js';
import { Attendance } from '../models/Attendance.js';
import { ExtraDay } from '../models/ExtraDay.js';
import { Franchise } from '../models/Franchise.js';
import { Incentive } from '../models/Incentive.js';
import { PnlInput } from '../models/PnlInput.js';
import { Sale } from '../models/Sale.js';
import { User } from '../models/User.js';
import { isEmployeeActiveOn } from '../utils/employeeStatus.js';
import { datesBetween, localDateValue } from '../utils/dateUtils.js';
import { bodyRecord, isFranchiseAdmin, isPeriodValue, requireStore, stringQuery } from '../utils/franchiseRoute.js';
import { auditMutation, isMoneyAmount } from '../utils/businessLimits.js';
import { PNL_COST_OF_GOODS_KEYS, PNL_EXPENSE_KEYS, PNL_RENT_KEYS, PNL_STAFF_SALARY_KEY } from '../utils/pnlExpenses.js';
import { getCycleRange, resolveCycleSettings, roundCurrency } from '../utils/salaryCycle.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';

const expensiveReadLimiter = rateLimitMiddleware('expensive-read', rateLimits.expensiveRead, byUser);

export const franchisePnlRouter = Router();
const router = franchisePnlRouter;
const MAX_MONTHS = 36;
const MAX_FIELDS = 200;
const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,49}$/;

type PeriodType = 'calendar_month' | 'custom';
type ValueMap = Record<string, number>;

function monthValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function periodForDate(dateStr: string, cycleType: PeriodType, startDay: number) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (cycleType === 'calendar_month') return monthValue(date);
  const shifted = new Date(date);
  if (date.getDate() >= startDay) shifted.setMonth(shifted.getMonth() + 1);
  return monthValue(shifted);
}

function nextPeriod(period: string) {
  const [year, month] = period.split('-').map(Number);
  return monthValue(new Date(year, month, 1));
}

function toPlainValues(values: unknown): ValueMap {
  if (values instanceof Map) return Object.fromEntries(values) as ValueMap;
  return (values as ValueMap | null | undefined) ?? {};
}

function finiteNonNegative(value: unknown): value is number {
  return isMoneyAmount(value);
}

const ALLOWED_INPUT_KEYS = new Set<string>(['netSales', 'nob', ...PNL_EXPENSE_KEYS]);

router.get('/pnl', requireAuth, expensiveReadLimiter, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;

  const store = await Franchise.findById(storeId)
    .select('name salaryCycleType salaryCycleStartDay salaryCycleEndDay')
    .lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }

  const { cycleType, startDay } = resolveCycleSettings(store);
  const today = localDateValue();
  const currentPeriod = periodForDate(today, cycleType, startDay);
  const earliestSale = await Sale.findOne({ franchise: storeId }).sort({ date: 1 }).select('date').lean();
  if (!earliestSale) {
    response.json({ store: { id: String(store._id), name: store.name }, months: [] });
    return;
  }

  const earliestPeriod = periodForDate(earliestSale.date, cycleType, startDay);
  const periods: string[] = [];
  for (let cursor = earliestPeriod; cursor <= currentPeriod && periods.length < MAX_MONTHS; cursor = nextPeriod(cursor)) {
    periods.push(cursor);
  }
  const periodsToShow = periods.slice(-MAX_MONTHS);
  const overallFrom = getCycleRange(periodsToShow[0], cycleType, startDay).from;
  const overallTo = getCycleRange(periodsToShow[periodsToShow.length - 1], cycleType, startDay).to;

  const [employees, sales, attendance, incentives, extraDays, advances, pnlInputs] = await Promise.all([
    User.find({ role: 'employee', franchises: storeId }).select('name salary dateOfJoining isActive archivedAt').lean(),
    Sale.find({ franchise: storeId, date: { $gte: overallFrom, $lte: overallTo } }).select('date totalSale totalExpenses swiggy zomato').lean(),
    Attendance.find({ franchise: storeId, date: { $gte: overallFrom, $lte: overallTo } }).select('employee date status').lean(),
    Incentive.find({ franchise: storeId, period: { $in: periodsToShow } }).lean(),
    ExtraDay.find({ franchise: storeId, period: { $in: periodsToShow } }).lean(),
    Advance.find({ franchise: storeId, period: { $in: periodsToShow } }).lean(),
    PnlInput.find({ franchise: storeId, period: { $in: periodsToShow } }).select('period values').lean(),
  ]);

  const attendanceByEmployee = new Map<string, Map<string, string>>();
  for (const record of attendance) {
    const employeeId = String(record.employee);
    const byDate = attendanceByEmployee.get(employeeId) ?? new Map<string, string>();
    byDate.set(record.date, record.status);
    attendanceByEmployee.set(employeeId, byDate);
  }
  const sumByEmployeePeriod = (
    rows: Array<{ employee: mongoose.Types.ObjectId; period: string; amount?: number; days?: number }>,
    field: 'amount' | 'days',
  ) => {
    const totals = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.employee}:${row.period}`;
      totals.set(key, (totals.get(key) ?? 0) + (row[field] ?? 0));
    }
    return totals;
  };
  const incentiveTotals = sumByEmployeePeriod(incentives, 'amount');
  const extraDayTotals = sumByEmployeePeriod(extraDays, 'days');
  const advanceTotals = sumByEmployeePeriod(advances, 'amount');
  const pnlInputsByPeriod = new Map(pnlInputs.map((input) => [input.period, toPlainValues(input.values)]));

  const months = periodsToShow.map((period) => {
    const range = getCycleRange(period, cycleType, startDay);
    const periodSales = sales.filter((sale) => sale.date >= range.from && sale.date <= range.to);
    const revenue = periodSales.reduce((sum, sale) => sum + sale.totalSale, 0);
    const storeExpenses = periodSales.reduce((sum, sale) => sum + sale.totalExpenses, 0);
    const swiggyRevenue = periodSales.reduce((sum, sale) => sum + sale.swiggy, 0);
    const zomatoRevenue = periodSales.reduce((sum, sale) => sum + sale.zomato, 0);
    const cycleDates = datesBetween(range.from, range.to);
    const elapsedDates = cycleDates.filter((date) => date <= today);
    let calculatedPayroll = 0;
    for (const employee of employees) {
      const employeeId = String(employee._id);
      const payableDates = elapsedDates.filter((date) => isEmployeeActiveOn(employee, date));
      const records = attendanceByEmployee.get(employeeId) ?? new Map<string, string>();
      const paidDays = payableDates.filter((date) => {
        const status = records.get(date);
        return status === 'Present' || status === 'Week Off';
      }).length;
      const salary = employee.salary ?? 0;
      const incentiveTotal = incentiveTotals.get(`${employeeId}:${period}`) ?? 0;
      const extraDaysTotal = extraDayTotals.get(`${employeeId}:${period}`) ?? 0;
      const advanceTotal = advanceTotals.get(`${employeeId}:${period}`) ?? 0;
      if (paidDays === 0 && incentiveTotal === 0 && extraDaysTotal === 0 && advanceTotal === 0) continue;
      calculatedPayroll += roundCurrency((salary * (paidDays + extraDaysTotal)) / cycleDates.length) + incentiveTotal - advanceTotal;
    }

    const inputValues = pnlInputsByPeriod.get(period) ?? {};
    const enteredStaffSalary = inputValues[PNL_STAFF_SALARY_KEY] ?? 0;
    const payroll = enteredStaffSalary > 0 ? enteredStaffSalary : calculatedPayroll;
    const netSales = inputValues.netSales ?? roundCurrency(revenue * 0.95);
    const costOfGoods = PNL_COST_OF_GOODS_KEYS.reduce((sum, key) => sum + (inputValues[key] ?? 0), 0);
    const grossProfit = netSales - costOfGoods;
    const rentExpenses = PNL_RENT_KEYS.reduce((sum, key) => sum + (inputValues[key] ?? 0), 0);
    const manualExpenses = PNL_EXPENSE_KEYS.reduce((sum, key) => sum + (
      key === PNL_STAFF_SALARY_KEY || PNL_COST_OF_GOODS_KEYS.includes(key as typeof PNL_COST_OF_GOODS_KEYS[number]) || PNL_RENT_KEYS.includes(key as typeof PNL_RENT_KEYS[number])
        ? 0
        : inputValues[key] ?? 0
    ), 0);
    const totalStoreExpenses = rentExpenses + manualExpenses;
    const totalExpenses = totalStoreExpenses + payroll;
    const netProfit = grossProfit - totalExpenses;
    const margin = netSales > 0 ? (netProfit / netSales) * 100 : 0;

    return {
      period, from: range.from, to: range.to, revenue, netSales, grossProfit,
      salesExpenses: storeExpenses, storeExpenses: totalStoreExpenses, payroll,
      totalExpenses, netProfit, margin, swiggyRevenue, zomatoRevenue,
      isCurrent: period === currentPeriod,
    };
  });

  response.json({
    store: { id: String(store._id), name: store.name },
    cycle: { type: cycleType, startDay },
    months: months.reverse(),
  });
});

router.get('/pnl/inputs', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const period = stringQuery(request, 'period') ?? '';
  if (!isPeriodValue(period)) { response.status(400).json({ message: 'A valid period is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const input = await PnlInput.findOne({ franchise: storeId, period }).lean();
  response.json({ input: input ? { period: input.period, values: toPlainValues(input.values) } : null });
});

router.put('/pnl/inputs', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const body = bodyRecord(request);
  const period = body.period;
  if (!isPeriodValue(period)) { response.status(400).json({ message: 'A valid period is required.' }); return; }
  const entries = Object.entries(body.values && typeof body.values === 'object' ? body.values as Record<string, unknown> : {});
  if (entries.length > MAX_FIELDS) { response.status(400).json({ message: 'Too many fields.' }); return; }
  const values: ValueMap = {};
  for (const [key, value] of entries) {
    if (!FIELD_KEY_PATTERN.test(key) || !ALLOWED_INPUT_KEYS.has(key)) { response.status(400).json({ message: `Invalid field name: ${key}.` }); return; }
    if (!finiteNonNegative(value)) { response.status(400).json({ message: `Enter a valid value for ${key}.` }); return; }
    values[key] = value;
  }

  const storeId = await requireStore(request, response);
  if (!storeId) return;
  if (!(await Franchise.exists({ _id: storeId }))) { response.status(404).json({ message: 'Store not found.' }); return; }
  const input = await PnlInput.findOneAndUpdate(
    { franchise: storeId, period },
    { $set: { values }, $setOnInsert: { createdBy: new mongoose.Types.ObjectId(request.auth!.id) } },
    { new: true, upsert: true, runValidators: true },
  ).lean();
  auditMutation(request, 'pnl.inputs.saved', { storeId, targetId: storeId, after: { period, values } });
  response.json({ message: 'P&L inputs saved.', input: { period: input!.period, values: toPlainValues(input!.values) } });
});
