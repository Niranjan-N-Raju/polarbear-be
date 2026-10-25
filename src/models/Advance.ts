import mongoose, { Schema } from 'mongoose';

export interface AdvanceRecord {
  _id: mongoose.Types.ObjectId;
  franchise: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  period: string;
  type: string;
  amount: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<AdvanceRecord>(
  {
    franchise: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    employee: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    type: { type: String, required: true, trim: true, maxlength: 100 },
    amount: { type: Number, required: true, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

schema.index({ franchise: 1, employee: 1, period: 1 });

export const Advance = (mongoose.models.Advance as mongoose.Model<AdvanceRecord> | undefined)
  ?? mongoose.model<AdvanceRecord>('Advance', schema);
