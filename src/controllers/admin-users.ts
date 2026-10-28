import bcrypt from 'bcryptjs';
import type { Request,Response } from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { Franchise } from '../models/Franchise.js';
import { User } from '../models/User.js';
import { ADMIN_USER_PROJECTION,adminUserView,pageValue } from '../services/admin-users.js';
import { clampPage,escapeRegex,isSearchTooLong,SEARCH_TOO_LONG_MESSAGE } from '../utils/listQuery.js';

import { auditLog } from '../utils/audit.js';
import { checkRateLimit,rateLimits } from '../utils/rateLimit.js';
import { bodyTooLarge } from '../utils/requestBody.js';
import { createUserSchema,firstValidationMessage,passwordSchema,patchUserSchema } from '../utils/validation.js';
export async function getUsers(request: Request, response: Response) {
  await userListResponse(request, response);
}

export async function getUsersId(request: Request<{ id: string }>, response: Response) {
  await userListResponse(request, response, request.params.id);
}

export async function postUsers(request: Request, response: Response) {
  const auth = request.auth!;
  const limit = checkRateLimit(`user-create:${auth.id}`, rateLimits.userCreate);
  if (!limit.allowed) {
    response.setHeader('Retry-After', String(Math.ceil((limit.retryAfterMs ?? 0) / 1000)));
    response.status(429).json({ message: 'Too many requests. Please try again later.' });
    return;
  }
  if (bodyTooLarge(request.body, 50_000)) {
    response.status(413).json({ message: 'Request body too large.' });
    return;
  }
  const parsed = createUserSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: firstValidationMessage(parsed.error) });
    return;
  }
  const body = parsed.data;
  const role = body.role ?? 'employee';
  if (!['sub_admin', 'franchise_admin', 'employee'].includes(role)) {
    response.status(403).json({ message: 'You are not allowed to assign this role.' });
    return;
  }
  if (!body.name.trim()) {
    response.status(400).json({ message: 'Name is required.' });
    return;
  }

  let email = body.email?.trim().toLowerCase();
  let password = body.password;
  if (role !== 'employee') {
    if (!email) {
      response.status(400).json({ message: 'Email is required.' });
      return;
    }
    if (!password) {
      response.status(400).json({ message: 'Password is required.' });
      return;
    }
    const passwordResult = passwordSchema.safeParse(password);
    if (!passwordResult.success) {
      response.status(400).json({ message: firstValidationMessage(passwordResult.error) });
      return;
    }
  } else {
    email = email || `emp_${randomBytes(12).toString('hex')}@nologin.internal`;
    password = password || randomBytes(32).toString('hex');
  }

  if (role === 'franchise_admin' && (body.franchiseIds ?? []).length === 0) {
    response.status(400).json({ message: 'Store admin must be assigned to at least one store.' });
    return;
  }
  if (role === 'employee' && (body.franchiseIds ?? []).length !== 1) {
    response.status(400).json({ message: 'An employee must be assigned to exactly one store.' });
    return;
  }
  const franchiseIds = body.franchiseIds ?? [];
  if (franchiseIds.some((id) => !mongoose.isValidObjectId(id))) {
    response.status(400).json({ message: 'Invalid store assignment.' });
    return;
  }
  if (franchiseIds.length > 0) {
    const count = await Franchise.countDocuments({ _id: { $in: franchiseIds } });
    if (count !== new Set(franchiseIds).size) {
      response.status(400).json({ message: 'One or more assigned stores do not exist.' });
      return;
    }
  }
  if (await User.exists({ email })) {
    response.status(409).json({ message: 'A user with this email already exists.' });
    return;
  }

  const user = await User.create({
    name: body.name.trim(),
    email,
    password: await bcrypt.hash(password, 12),
    role,
    isActive: true,
    createdBy: new mongoose.Types.ObjectId(auth.id),
    franchises: role === 'sub_admin' ? [] : franchiseIds,
    // The creating admin knows this password, so the user must replace it before using the app.
    mustChangePassword: true,
  });
  auditLog('user.created', {
    actorId: auth.id,
    actorRole: auth.role,
    targetId: String(user._id),
    ip: request.ip,
    metadata: { role, email },
  });
  response.status(201).json({
    message: 'User created successfully.',
    user: { _id: String(user._id), name: user.name, email: user.email, role: user.role },
  });
}

export async function patchUsersId(request: Request<{ id: string }>, response: Response) {
  const id = request.params.id;
  if (!mongoose.isValidObjectId(id)) {
    response.status(404).json({ message: 'User not found.' });
    return;
  }
  if (bodyTooLarge(request.body, 50_000)) {
    response.status(413).json({ message: 'Request body too large.' });
    return;
  }
  const parsed = patchUserSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: firstValidationMessage(parsed.error) });
    return;
  }
  const auth = request.auth!;
  if (id === auth.id) {
    response.status(400).json({ message: 'You cannot modify your own account here.' });
    return;
  }
  const target = await User.findById(id);
  if (!target) {
    response.status(404).json({ message: 'User not found.' });
    return;
  }
  if (target.role === 'admin') {
    response.status(403).json({ message: 'Administrators can only be managed by themselves.' });
    return;
  }

  const { name, role, franchiseIds, phone } = parsed.data;
  if (role && !['sub_admin', 'franchise_admin', 'employee'].includes(role)) {
    response.status(403).json({ message: 'You are not allowed to assign this role.' });
    return;
  }
  const effectiveRole = role ?? target.role;
  const roleChanged = role !== undefined && role !== target.role;
  // When the role changes without new assignments, the existing assignments must still be valid
  // for the new role; otherwise a stale store list would silently grant the new role store access.
  const effectiveStoreCount = franchiseIds?.length ?? (effectiveRole === 'sub_admin' ? 0 : target.franchises.length);
  if (effectiveRole === 'franchise_admin' && (franchiseIds !== undefined || roleChanged) && effectiveStoreCount === 0) {
    response.status(400).json({ message: 'Store admin must be assigned to at least one store.' });
    return;
  }
  if (effectiveRole === 'employee' && (franchiseIds !== undefined || roleChanged) && effectiveStoreCount !== 1) {
    response.status(400).json({ message: 'An employee must be assigned to exactly one store.' });
    return;
  }
  if (franchiseIds?.some((storeId) => !mongoose.isValidObjectId(storeId))) {
    response.status(400).json({ message: 'Invalid store assignment.' });
    return;
  }
  if (franchiseIds && franchiseIds.length > 0) {
    const count = await Franchise.countDocuments({ _id: { $in: franchiseIds } });
    if (count !== new Set(franchiseIds).size) {
      response.status(400).json({ message: 'One or more assigned stores do not exist.' });
      return;
    }
  }

  const assignmentsChanged = franchiseIds !== undefined && (
    target.franchises.length !== franchiseIds.length ||
    target.franchises.some((storeId) => !franchiseIds.includes(String(storeId)))
  );
  if ((role && role !== target.role) || assignmentsChanged) {
    target.sessionVersion = (target.sessionVersion ?? 0) + 1;
  }
  if (name !== undefined) target.name = name;
  if (role !== undefined) target.role = role;
  if (franchiseIds !== undefined) target.franchises = franchiseIds.map((storeId) => new mongoose.Types.ObjectId(storeId));
  // Sub-admins are never store-scoped; drop any assignments left over from a previous role.
  if (effectiveRole === 'sub_admin' && target.franchises.length > 0) {
    target.franchises = [];
    target.sessionVersion = (target.sessionVersion ?? 0) + (roleChanged || assignmentsChanged ? 0 : 1);
  }
  if (phone !== undefined) target.phone = phone;
  await target.save();

  auditLog('user.updated', {
    actorId: auth.id,
    actorRole: auth.role,
    targetId: id,
    ip: request.ip,
    metadata: { fields: Object.keys(parsed.data) },
  });
  response.json({
    message: 'User updated.',
    user: { _id: String(target._id), name: target.name, email: target.email, role: target.role },
  });
}

export async function deleteUsersId(request: Request<{ id: string }>, response: Response) {
  const id = request.params.id;
  const auth = request.auth!;
  if (!mongoose.isValidObjectId(id)) {
    response.status(404).json({ message: 'User not found.' });
    return;
  }
  if (id === auth.id) {
    response.status(400).json({ message: 'You cannot delete your own account.' });
    return;
  }
  const target = await User.findById(id).select('_id role isActive archivedAt');
  if (!target) {
    response.status(404).json({ message: 'User not found.' });
    return;
  }
  if (target.role === 'admin') {
    response.status(403).json({ message: 'Administrators can only be managed by themselves.' });
    return;
  }
  if (target.role === 'employee') {
    target.isActive = false;
    target.archivedAt = new Date();
    target.sessionVersion = (target.sessionVersion ?? 0) + 1;
    await target.save();
    auditLog('user.archived', { actorId: auth.id, actorRole: auth.role, targetId: id, ip: request.ip });
    response.json({ message: 'Employee archived.' });
    return;
  }

  await target.deleteOne();
  auditLog('user.deleted', { actorId: auth.id, actorRole: auth.role, targetId: id, ip: request.ip });
  response.json({ message: 'User deleted.' });
}

export async function userListResponse(
  request: Request,
  response: Response,
  singleId?: string,
): Promise<void> {
  const auth = request.auth!;
  if (singleId && !mongoose.isValidObjectId(singleId)) {
    response.status(404).json({ message: 'User not found.' });
    return;
  }

  const query: Record<string, unknown> = { _id: { $ne: auth.id } };
  if (!singleId) {
    if (request.query.includeArchived !== 'true') query.isActive = { $ne: false };
    if (request.query.excludeEmployees === 'true') query.role = { $ne: 'employee' };
    if (typeof request.query.franchiseId === 'string' && request.query.franchiseId) {
      if (!mongoose.isValidObjectId(request.query.franchiseId)) {
        response.status(400).json({ message: 'Invalid store id.' });
        return;
      }
      query.franchises = request.query.franchiseId;
    }
    if (isSearchTooLong(request.query.search)) {
      response.status(400).json({ message: SEARCH_TOO_LONG_MESSAGE });
      return;
    }
    if (typeof request.query.search === 'string' && request.query.search.trim()) {
      const search = new RegExp(escapeRegex(request.query.search.trim()), 'i');
      query.$or = [{ name: search }, { email: search }, { phone: search }];
    }
    if (request.query.status === 'active') query.isActive = { $ne: false };
    else if (request.query.status === 'inactive') query.isActive = false;
    else if (request.query.status !== undefined && request.query.status !== 'all') {
      response.status(400).json({ message: 'Invalid user status.' });
      return;
    }
    if (typeof request.query.role === 'string' && request.query.role && request.query.role !== 'all') {
      if (!['admin', 'sub_admin', 'franchise_admin', 'employee'].includes(request.query.role)) {
        response.status(400).json({ message: 'Invalid user type.' });
        return;
      }
      query.role = request.query.role;
    }
  } else {
    query._id = singleId;
  }

  if (singleId) {
    const user = await User.findOne(query).select(ADMIN_USER_PROJECTION).lean();
    if (!user) {
      response.status(404).json({ message: 'User not found.' });
      return;
    }
    const franchises = await Franchise.find({ _id: { $in: user.franchises ?? [] } })
      .select('_id name')
      .lean();
    response.json({
      user: adminUserView(user, franchises.map((store) => ({ _id: String(store._id), name: store.name }))),
    });
    return;
  }

  const page = clampPage(pageValue(request.query.page, 1));
  const limit = Math.min(500, pageValue(request.query.limit, 10));
  const [users, total] = await Promise.all([
    User.find(query).select(ADMIN_USER_PROJECTION).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(query),
  ]);
  const franchiseIds = [...new Set(users.flatMap((user) => (user.franchises ?? []).map(String)))];
  const stores = franchiseIds.length > 0
    ? await Franchise.find({ _id: { $in: franchiseIds } }).select('_id name').lean()
    : [];
  const storeNames = new Map(stores.map((store) => [String(store._id), store.name]));

  response.json({
    users: users.map((user) => adminUserView(user, (user.franchises ?? []).map((id) => ({
      _id: String(id),
      name: storeNames.get(String(id)) ?? 'Unknown',
    })))),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}