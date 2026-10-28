import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';

import { deleteAttendance, getAttendance, getAttendanceWeeklyRoster, putAttendance, putAttendanceWeeklyRoster } from '../controllers/franchise-attendance.js';
export const franchiseAttendanceRouter = Router();
const router = franchiseAttendanceRouter;
const expensiveReadLimiter = rateLimitMiddleware('expensive-read', rateLimits.expensiveRead, byUser);
router.get('/attendance', requireAuth, expensiveReadLimiter, getAttendance);
router.put('/attendance', requireAuth, putAttendance);
router.delete('/attendance', requireAuth, deleteAttendance);
router.get('/attendance/weekly-roster', requireAuth, getAttendanceWeeklyRoster);
router.put('/attendance/weekly-roster', requireAuth, putAttendanceWeeklyRoster);
