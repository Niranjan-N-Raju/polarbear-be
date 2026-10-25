import mongoose, { Schema } from 'mongoose';

export interface ExtraDayRecord {
  _id: mongoose.Types.ObjectId;
  franchise: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  period: string;
  type: string;
  days: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<ExtraDayRecord>(
  {
    franchise: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    employee: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    type: { type: String, required: true, trim: true, maxlength: 100 },
    days: { type: Number, required: true, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

schema.index({ franchise: 1, employee: 1, period: 1 });

export const ExtraDay = (mongoose.models.ExtraDay as mongoose.Model<ExtraDayRecord> | undefined)
  ?? mongoose.model<ExtraDayRecord>('ExtraDay', schema);
