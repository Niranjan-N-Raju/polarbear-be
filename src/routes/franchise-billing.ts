import { Router } from "express";
import { getBills, getBillingTables, postBill, postBillingTable } from "../controllers/franchise-billing.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { byUser, rateLimitMiddleware, rateLimits } from "../utils/rateLimit.js";

export const franchiseBillingRouter = Router();
const billingReadLimiter = rateLimitMiddleware("billing-read", rateLimits.expensiveRead, byUser);
franchiseBillingRouter.get("/bills", requireAuth, requireRole("franchise_admin"), billingReadLimiter, getBills);
franchiseBillingRouter.post("/bills", requireAuth, requireRole("franchise_admin"), postBill);
franchiseBillingRouter.get("/billing-tables", requireAuth, requireRole("franchise_admin"), getBillingTables);
franchiseBillingRouter.post("/billing-tables", requireAuth, requireRole("franchise_admin"), postBillingTable);