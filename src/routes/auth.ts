import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
byUser,
rateLimitMiddleware,
rateLimits
} from "../utils/rateLimit.js";

import { postExtend,postLogin,postLogout } from '../controllers/auth.js';
export const authRouter = Router();

authRouter.post("/login", postLogin);
authRouter.post('/extend', requireAuth, rateLimitMiddleware('session-extend', rateLimits.sessionExtend, byUser), postExtend);
authRouter.post('/logout', requireAuth, rateLimitMiddleware('logout', rateLimits.logout, byUser), postLogout);
