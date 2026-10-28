import { Router } from 'express';
import { requireAuth,requireRole } from '../middleware/auth.js';

import { deleteUsersId,getUsers,getUsersId,patchUsersId,postUsers } from '../controllers/admin-users.js';
export const adminUsersRouter = Router();

adminUsersRouter.use('/users', requireAuth, requireRole('admin'));
adminUsersRouter.get('/users', getUsers);
adminUsersRouter.get('/users/:id', getUsersId);
adminUsersRouter.post('/users', postUsers);
adminUsersRouter.patch('/users/:id', patchUsersId);
adminUsersRouter.delete('/users/:id', deleteUsersId);
