import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  byUser,
  rateLimitMiddleware,
  rateLimits
} from "../utils/rateLimit.js";

import { postExtend, postLogin, postLogout, postSession } from '../controllers/auth.js';
import { deleteWebSession, restoreWebSession } from '../utils/webSession.js';
export const authRouter = Router();

authRouter.post("/login", postLogin);
authRouter.post('/session', restoreWebSession, postSession);
authRouter.delete('/session', deleteWebSession);
authRouter.post('/extend', requireAuth, rateLimitMiddleware('session-extend', rateLimits.sessionExtend, byUser), postExtend);
authRouter.post('/logout', requireAuth, rateLimitMiddleware('logout', rateLimits.logout, byUser), postLogout);
