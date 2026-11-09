import mongoose, { Schema } from "mongoose";

export interface ProductCategoryRecord {
  _id: mongoose.Types.ObjectId;
  name: string;
  normalizedName: string;
  createdAt: Date;
}

const productCategorySchema = new Schema<ProductCategoryRecord>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    normalizedName: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: "product_categories", versionKey: false, autoIndex: false }
);
productCategorySchema.index({ normalizedName: 1 }, { unique: true });

export const ProductCategory =
  (mongoose.models.ProductCategory as
    | mongoose.Model<ProductCategoryRecord>
    | undefined) ??
  mongoose.model<ProductCategoryRecord>(
    "ProductCategory",
    productCategorySchema
  );