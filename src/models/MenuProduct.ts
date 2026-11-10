import mongoose, { Schema } from "mongoose";

export interface CompositionItem {
  productId: mongoose.Types.ObjectId;
  quantity: number;
}

export interface MenuProductRecord {
  name: string;
  normalizedName: string;
  price: number;
  categoryId: mongoose.Types.ObjectId;
  dineIn: CompositionItem[];
  takeAway: CompositionItem[];
  createdAt: Date;
}

const compositionItemSchema = new Schema<CompositionItem>({
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  quantity: { type: Number, required: true, validate: (value: number) => Number.isFinite(value) && value > 0 },
}, { _id: false });

const composition = {
  type: [compositionItemSchema],
  required: true,
  validate: (items: CompositionItem[]) => items.length > 0 && items.length <= 100 && new Set(items.map((item) => String(item.productId))).size === items.length,
};

const schema = new Schema<MenuProductRecord>({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  normalizedName: { type: String, required: true },
  price: { type: Number, required: true, min: 0.01, max: 1_000_000, validate: (value: number) => Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001 },
  categoryId: { type: Schema.Types.ObjectId, ref: "ProductCategory", required: true },
  dineIn: composition,
  takeAway: composition,
  createdAt: { type: Date, default: () => new Date() },
}, { collection: "menu_products", versionKey: false, autoIndex: false });
schema.index({ normalizedName: 1 }, { unique: true });
schema.index({ categoryId: 1 });

export const MenuProduct =
  (mongoose.models.MenuProduct as mongoose.Model<MenuProductRecord> | undefined) ??
  mongoose.model<MenuProductRecord>("MenuProduct", schema);