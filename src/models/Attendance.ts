import mongoose, { Schema } from 'mongoose';

export interface AttendanceRecord {
  _id: mongoose.Types.ObjectId;
  franchise: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  date: string;
  status: 'Present' | 'Week Off' | 'Absent';
  comment?: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<AttendanceRecord>(
  {
    employee: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    franchise: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ['Present', 'Week Off', 'Absent'], required: true },
    comment: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

schema.index({ franchise: 1, date: 1, employee: 1 }, { unique: true });

export const Attendance = (mongoose.models.Attendance as mongoose.Model<AttendanceRecord> | undefined)
  ?? mongoose.model<AttendanceRecord>('Attendance', schema);
