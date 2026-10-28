import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';

import { deleteStoresLogo, getStoresBranding, getStoresCycle, getStoresLogo, getStoresPositions, getStoresShifts, postStoresLogo, putStoresBranding, putStoresCycle, putStoresPositions, putStoresShifts } from '../controllers/franchise-store-config.js';
export const franchiseStoreConfigRouter = Router();
const router = franchiseStoreConfigRouter;
const uploadLimiter = rateLimitMiddleware('upload', rateLimits.upload, byUser);
router.get('/stores/branding', requireAuth, getStoresBranding);
router.put('/stores/branding', requireAuth, putStoresBranding);
router.get('/stores/logo', requireAuth, uploadLimiter, getStoresLogo);
router.post('/stores/logo', requireAuth, uploadLimiter, postStoresLogo);
router.delete('/stores/logo', requireAuth, deleteStoresLogo);
router.get('/stores/cycle', requireAuth, getStoresCycle);
router.put('/stores/cycle', requireAuth, putStoresCycle);
router.get('/stores/positions', requireAuth, getStoresPositions);
router.put('/stores/positions', requireAuth, putStoresPositions);
router.get('/stores/shifts', requireAuth, getStoresShifts);
router.put('/stores/shifts', requireAuth, putStoresShifts);
