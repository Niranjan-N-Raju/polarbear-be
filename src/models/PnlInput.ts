import mongoose, { Schema } from 'mongoose';

export interface PnlInputRecord {
  _id: mongoose.Types.ObjectId;
  franchise: mongoose.Types.ObjectId;
  period: string;
  values: Map<string, number>;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<PnlInputRecord>(
  {
    franchise: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    values: { type: Map, of: Number, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

schema.index({ franchise: 1, period: 1 }, { unique: true });

export const PnlInput = (mongoose.models.PnlInput as mongoose.Model<PnlInputRecord> | undefined)
  ?? mongoose.model<PnlInputRecord>('PnlInput', schema);
