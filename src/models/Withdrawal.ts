import mongoose, { Schema } from 'mongoose';

export interface WithdrawalRecord {
  _id: mongoose.Types.ObjectId;
  franchise: mongoose.Types.ObjectId;
  date: string;
  amount: number;
  type: 'withdrawal' | 'repayment';
  reason?: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<WithdrawalRecord>(
  {
    franchise: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    amount: { type: Number, required: true, min: 0 },
    type: { type: String, enum: ['withdrawal', 'repayment'], required: true },
    reason: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

schema.index({ franchise: 1, date: -1 });

export const Withdrawal = (mongoose.models.Withdrawal as mongoose.Model<WithdrawalRecord> | undefined)
  ?? mongoose.model<WithdrawalRecord>('Withdrawal', schema);
