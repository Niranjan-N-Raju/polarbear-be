import type { Response } from 'express';
import mongoose from 'mongoose';
import { Franchise } from '../models/Franchise.js';
import { User } from '../models/User.js';

export function isDateValue(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface VisibleStore {
  _id: unknown;
  isActive?: boolean;
  archivedAt?: Date | null;
}

/** Only store-level roles may hold store-data access; admins (including store creators) never do. */
const STORE_DATA_ROLES = new Set(['franchise_admin', 'employee']);

/** Store access is granted only by explicit assignment in `User.franchises` to a store-level role. */
async function getVisibleStores(userId: string): Promise<VisibleStore[]> {
  const user = await User.findById(userId).select('role franchises').lean();
  if (!user || !STORE_DATA_ROLES.has(user.role)) return [];
  const assignedIds = (user.franchises ?? []).map(String);
  if (assignedIds.length === 0) return [];
  return Franchise.find({ _id: { $in: assignedIds } })
    .select('_id isActive archivedAt')
    .lean<VisibleStore[]>();
}

export async function getVisibleStoreIds(userId: string): Promise<string[]> {
  return (await getVisibleStores(userId)).map((store) => String(store._id));
}

export function isArchivedStore(store: { isActive?: boolean; archivedAt?: Date | null }): boolean {
  return store.isActive === false || Boolean(store.archivedAt);
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
  const store = (await getVisibleStores(userId)).find((candidate) => String(candidate._id) === storeId);
  if (!store) {
    response.status(403).json({ message: 'Access denied to this store.' });
    return null;
  }
  // Archived stores stay readable but reject every state-changing request.
  const method = (response.req?.method ?? 'GET').toUpperCase();
  if (!READ_ONLY_METHODS.has(method) && isArchivedStore(store)) {
    response.status(403).json({ message: 'This store is archived and is read-only.' });
    return null;
  }
  return new mongoose.Types.ObjectId(storeId);
}
