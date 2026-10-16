import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { Franchise } from '../models/Franchise.js';
import { User } from '../models/User.js';
import { auditLog } from '../utils/audit.js';
import { checkRateLimit, rateLimits } from '../utils/rateLimit.js';
import { firstValidationMessage, storeBodySchema } from '../utils/validation.js';

export const adminStoresRouter = Router();
adminStoresRouter.use(requireAuth, requireRole('admin'));

function bodyTooLarge(requestBody: unknown, limit = 10_000): boolean {
  return Buffer.byteLength(JSON.stringify(requestBody ?? {}), 'utf8') > limit;
}

function creatorId(id: string): mongoose.Types.ObjectId | string {
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id;
}

adminStoresRouter.get('/stores', async (request, response) => {
  const page = Math.max(1, Number.parseInt(String(request.query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? '50'), 10) || 50));
  const [franchises, total] = await Promise.all([
    Franchise.find({}).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Franchise.countDocuments({}),
  ]);

  response.json({
    franchises,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

adminStoresRouter.post('/stores', async (request, response) => {
  const auth = request.auth!;
  const rateLimit = checkRateLimit(`store-create:${auth.id}`, rateLimits.storeCreate);
  if (!rateLimit.allowed) {
    response.setHeader('Retry-After', String(Math.ceil((rateLimit.retryAfterMs ?? 0) / 1000)));
    response.status(429).json({ message: 'Too many requests. Please try again later.' });
    return;
  }
  if (bodyTooLarge(request.body)) {
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

    await User.findByIdAndUpdate(auth.id, { $addToSet: { franchises: franchise._id } });
    auditLog('store.created', {
      actorId: auth.id,
      actorRole: auth.role,
      targetId: String(franchise._id),
      ip: request.ip,
      metadata: { name: franchise.name, storeCode: franchise.storeCode },
    });
    response.status(201).json({ franchise });
  } catch (error) {
    if ((error as { code?: number; keyPattern?: Record<string, unknown> }).code === 11000) {
      response.status(409).json({ message: 'A store with this code already exists.' });
      return;
    }
    throw error;
  }
});

adminStoresRouter.patch('/stores', async (request, response) => {
  const auth = request.auth!;
  const id = typeof request.query.id === 'string' ? request.query.id : '';
  if (!mongoose.isValidObjectId(id)) {
    response.status(400).json({ message: 'A valid store id is required.' });
    return;
  }
  if (bodyTooLarge(request.body)) {
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
  const update = storeType === 'franchise'
    ? { $set: { ...body, storeType } }
    : { $set: { ...body, storeType }, $unset: { ownerName: 1, ownerPhone: 1, ownerEmail: 1 } };
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
    if ((error as { code?: number; keyPattern?: Record<string, unknown> }).code === 11000) {
      response.status(409).json({ message: 'A store with this code already exists.' });
      return;
    }
    throw error;
  }
});

adminStoresRouter.delete('/stores', async (request, response) => {
  const auth = request.auth!;
  const id = typeof request.query.id === 'string' ? request.query.id : '';
  if (!mongoose.isValidObjectId(id)) {
    response.status(400).json({ message: 'A valid store id is required.' });
    return;
  }
  const deleted = await Franchise.findOneAndDelete({
    _id: id,
    createdBy: creatorId(auth.id),
  }).lean();
  if (!deleted) {
    const exists = await Franchise.exists({ _id: id });
    response.status(exists ? 403 : 404).json({
      message: exists ? 'You can only delete stores you created.' : 'Store not found.',
    });
    return;
  }

  await User.updateMany({ franchises: id }, { $pull: { franchises: id } });
  auditLog('store.deleted', {
    actorId: auth.id,
    actorRole: auth.role,
    targetId: id,
    ip: request.ip,
    metadata: { name: deleted.name, storeCode: deleted.storeCode },
  });
  response.json({ message: 'Store deleted successfully.' });
});