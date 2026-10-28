import { Router } from 'express';
import { createEntry,deleteEntry,listEntry,updateEntry } from '../controllers/franchise-salary.js';
import { requireAuth } from '../middleware/auth.js';
import { byUser,rateLimitMiddleware,rateLimits } from '../utils/rateLimit.js';

import { getSalary,getSalarySlip,putSalary } from '../controllers/franchise-salary.js';
export const franchiseSalaryRouter = Router();
const router = franchiseSalaryRouter;
const expensiveReadLimiter = rateLimitMiddleware('expensive-read', rateLimits.expensiveRead, byUser);
router.get('/salary', requireAuth, expensiveReadLimiter, getSalary);
router.put('/salary', requireAuth, putSalary);
for (const kind of ['advance', 'incentive', 'extraDay'] as const) {
  const path = kind === 'extraDay' ? '/extra-days' : `/${kind}s`;
  router.get(path, requireAuth, (req, res, next) => listEntry(kind, req, res, next));
  router.post(path, requireAuth, (req, res, next) => createEntry(kind, req, res, next));
  router.put(`${path}/:id`, requireAuth, (req, res, next) => updateEntry(kind, req, res, next));
  router.delete(`${path}/:id`, requireAuth, (req, res, next) => deleteEntry(kind, req, res, next));
}
router.get('/salary/slip', requireAuth, expensiveReadLimiter, getSalarySlip);
