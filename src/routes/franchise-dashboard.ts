import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getDashboardStores, getFranchiseDashboard } from '../services/dashboard.js';
import { authorizeStore } from '../utils/storeAccess.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';
import { franchiseSalesRouter } from './franchise-sales.js';

const expensiveReadLimiter = rateLimitMiddleware('expensive-read', rateLimits.expensiveRead, byUser);

export const franchiseDashboardRouter = Router();

franchiseDashboardRouter.get('/stores', requireAuth, async (request, response, next) => {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  response.json({ franchises: await getDashboardStores(request.auth.id) });
});

franchiseDashboardRouter.get('/dashboard', requireAuth, expensiveReadLimiter, async (request, response, next) => {
  if (request.auth?.role !== 'franchise_admin') {
    next();
    return;
  }
  const storeObjectId = await authorizeStore(request.query.storeId, request.auth.id, response);
  if (!storeObjectId) return;
  response.json(await getFranchiseDashboard(storeObjectId, request.auth.id));
});

franchiseDashboardRouter.use(franchiseSalesRouter);
