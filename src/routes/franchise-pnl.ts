import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';

import { getPnl, getPnlInputs, putPnlInputs } from '../controllers/franchise-pnl.js';
export const franchisePnlRouter = Router();
const router = franchisePnlRouter;
const expensiveReadLimiter = rateLimitMiddleware('expensive-read', rateLimits.expensiveRead, byUser);
router.get('/pnl', requireAuth, expensiveReadLimiter, getPnl);
router.get('/pnl/inputs', requireAuth, getPnlInputs);
router.put('/pnl/inputs', requireAuth, putPnlInputs);
