import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Franchise } from '../models/Franchise.js';
import { ADMIN_STORE_LIST_FIELDS, creatorId } from '../services/admin-stores.js';
import { auditLog } from '../utils/audit.js';
import { clampPage, escapeRegex, isSearchTooLong, SEARCH_TOO_LONG_MESSAGE } from '../utils/listQuery.js';
import { bodyTooLarge } from '../utils/requestBody.js';
import { checkRateLimit, rateLimits } from '../utils/rateLimit.js';
import { firstValidationMessage, storeArchiveSchema, storeBodySchema } from '../utils/validation.js';
export async function getStores(request: Request, response: Response) {
  const page = clampPage(Math.max(1, Number.parseInt(String(request.query.page ?? '1'), 10) || 1));
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? '10'), 10) || 10));
  if (isSearchTooLong(request.query.search)) {
    response.status(400).json({ message: SEARCH_TOO_LONG_MESSAGE });
    return;
  }
  const query: Record<string, unknown> = {};
  if (typeof request.query.search === 'string' && request.query.search.trim()) {
    const search = new RegExp(escapeRegex(request.query.search.trim()), 'i');
    query.$or = [{ name: search }, { storeCode: search }];
  }
  if (request.query.status === 'active') {
    query.isActive = { $ne: false };
    query.archivedAt = { $in: [null] };
  } else if (request.query.status === 'archived') {
    const searchConditions = query.$or;
    delete query.$or;
    query.$and = [
      ...(searchConditions ? [{ $or: searchConditions }] : []),
      { $or: [{ isActive: false }, { archivedAt: { $ne: null } }] },
    ];
  } else if (request.query.status !== undefined && request.query.status !== 'all') {
    response.status(400).json({ message: 'Invalid store status.' });
    return;
  }
  if (typeof request.query.type === 'string' && request.query.type !== 'all') {
    if (!['company', 'franchise'].includes(request.query.type)) {
      response.status(400).json({ message: 'Invalid store type.' });
      return;
    }
    query.storeType = request.query.type;
  }
  const [franchises, total] = await Promise.all([
    Franchise.find(query).select(ADMIN_STORE_LIST_FIELDS).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Franchise.countDocuments(query),
  ]);

  const viewerId = request.auth!.id;
  // Owner contact details are only needed by the admin who manages (created) the store.
  const visibleFranchises = franchises.map((store) => {
    if (String(store.createdBy ?? '') === viewerId) return store;
    const { ownerPhone: _ownerPhone, ownerEmail: _ownerEmail, ...rest } = store;
    return rest;
  });

  response.json({
    franchises: visibleFranchises,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function postStores(request: Request, response: Response) {
  const auth = request.auth!;
  const rateLimit = checkRateLimit(`store-create:${auth.id}`, rateLimits.storeCreate);
  if (!rateLimit.allowed) {
    response.setHeader('Retry-After', String(Math.ceil((rateLimit.retryAfterMs ?? 0) / 1000)));
    response.status(429).json({ message: 'Too many requests. Please try again later.' });
    return;
  }
  if (bodyTooLarge(request.body, 10_000)) {
    response.status(413).json({ message: 'Request body too large.' });
    return;
  }

  const parsed = storeBodySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: firstValidationMessage(parsed.error) });
    return;
  }

  const body = parsed.data;
  const storeType = body.storeType === 'company' ? 'company' : 'franchise';
  try {
    const franchise = await Franchise.create({
      ...body,
      storeType,
      ownerName: storeType === 'franchise' ? body.ownerName : undefined,
      ownerPhone: storeType === 'franchise' ? body.ownerPhone : undefined,
      ownerEmail: storeType === 'franchise' ? body.ownerEmail : undefined,
      createdBy: creatorId(auth.id),
    });

    auditLog('store.created', {
      actorId: auth.id,
      actorRole: auth.role,
      targetId: String(franchise._id),
      ip: request.ip,
      metadata: { name: franchise.name, storeCode: franchise.storeCode },
    });
    response.status(201).json({ franchise });
  } catch (error) {
    if ((error as { code?: number; keyPattern?: Record<string, unknown>; }).code === 11000) {
      response.status(409).json({ message: 'A store with this code already exists.' });
      return;
    }
    throw error;
  }
}

export async function patchStores(request: Request, response: Response) {
  const auth = request.auth!;
  const id = typeof request.query.id === 'string' ? request.query.id : '';
  if (!mongoose.isValidObjectId(id)) {
    response.status(400).json({ message: 'A valid store id is required.' });
    return;
  }
  if (bodyTooLarge(request.body, 10_000)) {
    response.status(413).json({ message: 'Request body too large.' });
    return;
  }
  const parsed = storeBodySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: firstValidationMessage(parsed.error) });
    return;
  }

  const body = parsed.data;
  const storeType = body.storeType === 'company' ? 'company' : 'franchise';
  const { ownerName, ownerPhone, ownerEmail, ...storeFields } = body;
  const update = storeType === 'franchise'
    ? {
      $set: {
        ...storeFields,
        storeType,
        ...(ownerName !== undefined ? { ownerName } : {}),
        ...(ownerPhone !== undefined ? { ownerPhone } : {}),
        ...(ownerEmail !== undefined ? { ownerEmail } : {}),
      },
    }
    : { $set: { ...storeFields, storeType }, $unset: { ownerName: 1, ownerPhone: 1, ownerEmail: 1 } };
  try {
    const franchise = await Franchise.findOneAndUpdate(
      { _id: id, createdBy: creatorId(auth.id) },
      update,
      { new: true, runValidators: true },
    ).lean();
    if (!franchise) {
      const exists = await Franchise.exists({ _id: id });
      response.status(exists ? 403 : 404).json({
        message: exists ? 'You can only edit stores you created.' : 'Store not found.',
      });
      return;
    }
    auditLog('store.updated', {
      actorId: auth.id,
      actorRole: auth.role,
      targetId: id,
      ip: request.ip,
      metadata: { name: franchise.name, storeCode: franchise.storeCode },
    });
    response.json({ franchise });
  } catch (error) {
    if ((error as { code?: number; keyPattern?: Record<string, unknown>; }).code === 11000) {
      response.status(409).json({ message: 'A store with this code already exists.' });
      return;
    }
    throw error;
  }
}

export async function patchStoresArchive(request: Request, response: Response) {
  const auth = request.auth!;
  const id = typeof request.query.id === 'string' ? request.query.id : '';
  if (!mongoose.isValidObjectId(id)) {
    response.status(400).json({ message: 'A valid store id is required.' });
    return;
  }
  const parsed = storeArchiveSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: firstValidationMessage(parsed.error) });
    return;
  }

  const archivedAt = parsed.data.archived ? new Date() : undefined;
  const update = parsed.data.archived
    ? { $set: { isActive: false, archivedAt } }
    : { $set: { isActive: true }, $unset: { archivedAt: 1 } };
  const franchise = await Franchise.findOneAndUpdate(
    { _id: id, createdBy: creatorId(auth.id) },
    update,
    { new: true, runValidators: true },
  ).lean();
  if (!franchise) {
    const exists = await Franchise.exists({ _id: id });
    response.status(exists ? 403 : 404).json({
      message: exists ? 'You can only archive stores you created.' : 'Store not found.',
    });
    return;
  }

  auditLog(parsed.data.archived ? 'store.archived' : 'store.restored', {
    actorId: auth.id,
    actorRole: auth.role,
    targetId: id,
    ip: request.ip,
    metadata: { name: franchise.name, storeCode: franchise.storeCode },
  });
  response.json({ message: parsed.data.archived ? 'Store archived successfully.' : 'Store restored successfully.', franchise });
}
