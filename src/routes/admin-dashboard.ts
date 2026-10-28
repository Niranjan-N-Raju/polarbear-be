import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getAdminDashboard } from '../services/dashboard.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';

const expensiveReadLimiter = rateLimitMiddleware('expensive-read', rateLimits.expensiveRead, byUser);

export const adminDashboardRouter = Router();

adminDashboardRouter.get('/dashboard', requireAuth, requireRole('admin'), expensiveReadLimiter, async (_request, response) => {
  response.json(await getAdminDashboard());
});