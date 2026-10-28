import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';

import { getSales, postSales, putSalesId } from '../controllers/franchise-sales.js';
export const franchiseSalesRouter = Router();
const expensiveReadLimiter = rateLimitMiddleware('expensive-read', rateLimits.expensiveRead, byUser);
franchiseSalesRouter.get('/sales', requireAuth, expensiveReadLimiter, getSales);
franchiseSalesRouter.post('/sales', requireAuth, postSales);
franchiseSalesRouter.put('/sales/:id', requireAuth, putSalesId);
