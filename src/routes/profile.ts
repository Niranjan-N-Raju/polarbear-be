import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';


import { get, patch } from '../controllers/profile.js';
export const profileRouter = Router();

profileRouter.get('/', requireAuth, get);
profileRouter.patch('/', requireAuth, patch);
