import mongoose, { Schema } from 'mongoose';

/**
 * Records an explicitly deleted attendance mark so the weekly-roster default is not re-created
 * for that (store, employee, date). Shared with the Next.js app (same collection and shape).
 */
export interface AttendanceRemovalRecord {
  _id: mongoose.Types.ObjectId;
  franchise: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  date: string;
  createdBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<AttendanceRemovalRecord>(
  {
    franchise: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    employee: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { collection: 'attendance_removals', timestamps: true, autoIndex: false },
);

schema.index({ franchise: 1, employee: 1, date: 1 }, { unique: true });

export const AttendanceRemoval = (mongoose.models.AttendanceRemoval as mongoose.Model<AttendanceRemovalRecord> | undefined)
  ?? mongoose.model<AttendanceRemovalRecord>('AttendanceRemoval', schema);
