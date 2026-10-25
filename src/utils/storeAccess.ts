import type { Response } from 'express';
import mongoose from 'mongoose';
import { Franchise } from '../models/Franchise.js';
import { User } from '../models/User.js';

export function isDateValue(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function getVisibleStoreIds(userId: string): Promise<string[]> {
  const user = await User.findById(userId).select('franchises').lean();
  if (!user) return [];
  const assignedIds = (user.franchises ?? []).map(String);
  const stores = await Franchise.find({
    $or: [{ createdBy: new mongoose.Types.ObjectId(userId) }, { _id: { $in: assignedIds } }],
  })
    .select('_id')
    .lean();
    console.log(stores.map((store) => String(store._id)))
  return stores.map((store) => String(store._id));
}

export async function authorizeStore(
  storeId: unknown,
  userId: string,
  response: Response,
): Promise<mongoose.Types.ObjectId | null> {
  if (typeof storeId !== 'string' || !mongoose.isValidObjectId(storeId)) {
    response.status(400).json({ message: 'A valid storeId is required.' });
    return null;
  }
  const visibleIds = await getVisibleStoreIds(userId);
  if (!visibleIds.includes(storeId)) {
    response.status(403).json({ message: 'Access denied to this store.' });
    return null;
  }
  return new mongoose.Types.ObjectId(storeId);
}
