import type { Types } from 'mongoose';
import { Franchise } from '../models/Franchise.js';
import { Sale } from '../models/Sale.js';
import { User } from '../models/User.js';
import { getVisibleStoreIds } from '../utils/storeAccess.js';
import { addDaysToDateValue, businessDateValue, businessMonthRange } from '../utils/dateUtils.js';
import {
  computeExpenseBreakdown,
  computeMonthlyAttrition,
  computePaymentMixTrend,
  computeWeekdayPerformance,
} from '../utils/dashboardInsights.js';
import { MAX_INSIGHT_SALES } from './sales.js';

export async function getDashboardStores(userId: string) {
  const visibleIds = await getVisibleStoreIds(userId);
  return visibleIds.length
    ? Franchise.find({ _id: { $in: visibleIds } })
      .select('_id name address storeCode isActive archivedAt')
      .sort({ name: 1 })
      .lean()
    : [];
}

// The router must authorize storeObjectId first; this query service does not enforce store access.
export async function getFranchiseDashboard(storeObjectId: Types.ObjectId, userId: string) {
  const storeCount = (await getVisibleStoreIds(userId)).length;
  // Month and look-back bounds follow the India business day, not the server's timezone.
  const { from: monthFrom, to: monthTo } = businessMonthRange();
  const insightsFrom = addDaysToDateValue(businessDateValue(), -365);
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
    // Keep insight scans bounded as store history grows.
    Sale.find({ franchise: storeObjectId, date: { $gte: insightsFrom } })
      .select('date totalSale swiggy zomato upi cash expenses')
      .sort({ date: -1 })
      .limit(MAX_INSIGHT_SALES)
      .lean(),
  ]);
  return {
    storeCount,
    employeeSummary,
    salesSummary: monthlySales[0]?.total ?? 0,
    // Not calculated yet; do not infer attendance from employee headcount.
    attendanceSummary: 0,
    attritionTrend: computeMonthlyAttrition(employees),
    weekdayPerformance: computeWeekdayPerformance(sales),
    expenseBreakdown: computeExpenseBreakdown(sales),
    paymentMixTrend: computePaymentMixTrend(sales),
  };
}

export async function getAdminDashboard() {
  const [
    totalStores, activeStores, franchiseStores, companyStores,
    totalUsers, storeAdmins, subAdmins, employees,
  ] = await Promise.all([
    Franchise.countDocuments({}),
    Franchise.countDocuments({ isActive: true }),
    Franchise.countDocuments({ storeType: 'franchise' }),
    Franchise.countDocuments({ storeType: 'company' }),
    User.countDocuments({ role: { $ne: 'admin' } }),
    User.countDocuments({ role: 'franchise_admin' }),
    User.countDocuments({ role: 'sub_admin' }),
    User.countDocuments({ role: 'employee', isActive: { $ne: false } }),
  ]);
  return {
    totalStores, activeStores, inactiveStores: totalStores - activeStores,
    franchiseStores, companyStores, totalUsers, storeAdmins, subAdmins, employees,
  };
}
