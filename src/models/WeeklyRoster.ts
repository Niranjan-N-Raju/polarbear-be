import mongoose, { Schema } from 'mongoose';

export interface WeeklyRosterRecord {
  _id: mongoose.Types.ObjectId;
  franchise: mongoose.Types.ObjectId;
  weekStart: string;
  entries: { employee: mongoose.Types.ObjectId; days: { date: string; shift: string }[] }[];
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<WeeklyRosterRecord>(
  {
    franchise: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    weekStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    entries: {
      type: [new Schema({
        employee: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        days: {
          type: [new Schema({
            date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
            shift: { type: String, required: true, trim: true, maxlength: 80 },
          }, { _id: false })],
          default: [],
        },
      }, { _id: false })],
      default: [],
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

schema.index({ franchise: 1, weekStart: 1 }, { unique: true });

export const WeeklyRoster = (mongoose.models.WeeklyRoster as mongoose.Model<WeeklyRosterRecord> | undefined)
  ?? mongoose.model<WeeklyRosterRecord>('WeeklyRoster', schema);
