import { Router } from 'express';
import { requireAuth,requireRole } from '../middleware/auth.js';

import { getStores,patchStores,patchStoresArchive,postStores } from '../controllers/admin-stores.js';
export const adminStoresRouter = Router();

adminStoresRouter.use('/stores', requireAuth, requireRole('admin'));
adminStoresRouter.get('/stores', getStores);
adminStoresRouter.post('/stores', postStores);
adminStoresRouter.patch('/stores', patchStores);
adminStoresRouter.patch('/stores/archive', patchStoresArchive);
