import mongoose, { Schema } from 'mongoose';

// These collections are shared with the Next.js app, so names and field shapes must stay compatible.

export interface ProductRecord {
  _id: mongoose.Types.ObjectId;
  name: string;
  normalizedName: string;
  createdAt: Date;
}

export interface InventoryItemRecord {
  _id: mongoose.Types.ObjectId;
  storeId: string;
  productId: mongoose.Types.ObjectId;
  product: string;
  quantity: number;
  expiryDate: string;
  createdAt: Date;
}

export interface DumpedInventoryRecord {
  _id: mongoose.Types.ObjectId;
  inventoryItemId: mongoose.Types.ObjectId;
  storeId: string;
  productId: mongoose.Types.ObjectId;
  product: string;
  expiryDate: string;
  quantity: number;
  dumpedAt: Date;
}

const productSchema = new Schema<ProductRecord>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    normalizedName: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: 'products', versionKey: false, autoIndex: false },
);
productSchema.index({ normalizedName: 1 }, { unique: true });

const inventoryItemSchema = new Schema<InventoryItemRecord>(
  {
    storeId: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, required: true },
    product: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    expiryDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: 'inventory_items', versionKey: false, autoIndex: false },
);
inventoryItemSchema.index({ storeId: 1, productId: 1, expiryDate: 1 }, { unique: true });
inventoryItemSchema.index({ storeId: 1, expiryDate: 1 });

const dumpedInventorySchema = new Schema<DumpedInventoryRecord>(
  {
    inventoryItemId: { type: Schema.Types.ObjectId, required: true },
    storeId: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, required: true },
    product: { type: String, required: true },
    expiryDate: { type: String, required: true },
    quantity: { type: Number, required: true },
    dumpedAt: { type: Date, default: () => new Date() },
  },
  { collection: 'dumped_inventory', versionKey: false, autoIndex: false },
);
dumpedInventorySchema.index({ storeId: 1, dumpedAt: -1 });

export const Product = (mongoose.models.Product as mongoose.Model<ProductRecord> | undefined)
  ?? mongoose.model<ProductRecord>('Product', productSchema);
export const InventoryItem = (mongoose.models.InventoryItem as mongoose.Model<InventoryItemRecord> | undefined)
  ?? mongoose.model<InventoryItemRecord>('InventoryItem', inventoryItemSchema);
export const DumpedInventory = (mongoose.models.DumpedInventory as mongoose.Model<DumpedInventoryRecord> | undefined)
  ?? mongoose.model<DumpedInventoryRecord>('DumpedInventory', dumpedInventorySchema);
