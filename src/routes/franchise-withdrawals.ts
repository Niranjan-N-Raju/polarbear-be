import { Router } from 'express';
import { deleteWithdrawalsId,getWithdrawals,postWithdrawals,putWithdrawalsId } from '../controllers/franchise-withdrawals.js';
import { requireAuth } from '../middleware/auth.js';
export { MAX_WITHDRAWAL_RESULTS } from '../services/franchise-withdrawals.js';
export const franchiseWithdrawalsRouter = Router();
const router = franchiseWithdrawalsRouter;

router.get('/withdrawals', requireAuth, getWithdrawals);
router.post('/withdrawals', requireAuth, postWithdrawals);
router.put('/withdrawals/:id', requireAuth, putWithdrawalsId);
router.delete('/withdrawals/:id', requireAuth, deleteWithdrawalsId);
