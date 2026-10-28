import mongoose from 'mongoose';
export function creatorId(id: string): mongoose.Types.ObjectId | string {
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id;
}
export const ADMIN_STORE_LIST_FIELDS =
  'name storeCode storeType description address phone ownerName ownerPhone ownerEmail isActive archivedAt createdBy createdAt updatedAt';
