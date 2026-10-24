import mongoose, { Schema } from 'mongoose';

export interface SaleExpense {
  name: string;
  amount: number;
}

export interface SaleRecord {
  _id: mongoose.Types.ObjectId;
  franchise: mongoose.Types.ObjectId;
  date: string;
  totalSale: number;
  swiggy: number;
  zomato: number;
  upi: number;
  upiCharge: number;
  cash: number;
  expenses: SaleExpense[];
  totalExpenses: number;
  bankingCash: number;
  createdBy?: mongoose.Types.ObjectId;
}

const saleSchema = new Schema<SaleRecord>(
  {
    franchise: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    totalSale: { type: Number, required: true, min: 0 },
    swiggy: { type: Number, required: true, min: 0, default: 0 },
    zomato: { type: Number, required: true, min: 0, default: 0 },
    upi: { type: Number, required: true, min: 0, default: 0 },
    upiCharge: { type: Number, min: 0, default: 0 },
    cash: { type: Number, required: true },
    expenses: {
      type: [{ name: { type: String, required: true, trim: true }, amount: { type: Number, required: true, min: 0 } }],
      default: [],
    },
    totalExpenses: { type: Number, default: 0 },
    bankingCash: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, autoIndex: false },
);

saleSchema.index({ franchise: 1, date: 1 }, { unique: true });

export const Sale =
  (mongoose.models.Sale as mongoose.Model<SaleRecord> | undefined) ??
  mongoose.model<SaleRecord>('Sale', saleSchema);
