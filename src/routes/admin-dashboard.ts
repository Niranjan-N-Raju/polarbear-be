import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { Franchise } from '../models/Franchise.js';
import { User } from '../models/User.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';

const expensiveReadLimiter = rateLimitMiddleware('expensive-read', rateLimits.expensiveRead, byUser);

export const adminDashboardRouter = Router();

adminDashboardRouter.get('/dashboard', requireAuth, requireRole('admin'), expensiveReadLimiter, async (_request, response) => {
  const [
    totalStores,
    activeStores,
    franchiseStores,
    companyStores,
    totalUsers,
    storeAdmins,
    subAdmins,
    employees,
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

  response.json({
    totalStores,
    activeStores,
    inactiveStores: totalStores - activeStores,
    franchiseStores,
    companyStores,
    totalUsers,
    storeAdmins,
    subAdmins,
    employees,
  });
});