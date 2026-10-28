import { Router, type RequestHandler } from 'express';
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

// Other roles fall through to the admin dashboard router (which applies its own limiter) before
// this limiter runs, so a single admin request is never charged twice.
const franchiseOnly: RequestHandler = (request, _response, next) => {
  next(request.auth?.role === 'franchise_admin' ? undefined : 'route');
};

franchiseDashboardRouter.get('/dashboard', requireAuth, franchiseOnly, expensiveReadLimiter, async (request, response) => {
  const auth = request.auth!;
  const storeObjectId = await authorizeStore(request.query.storeId, auth.id, response);
  if (!storeObjectId) return;
  response.json(await getFranchiseDashboard(storeObjectId, auth.id));
});

franchiseDashboardRouter.use(franchiseSalesRouter);
