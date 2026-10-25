import mongoose, { Schema } from 'mongoose';
import { DEFAULT_POSITION_OPTIONS } from '../utils/employeePositions.js';

export type StoreType = 'company' | 'franchise';

export interface StoreShift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
}

export interface FranchiseLogo {
  fileId: mongoose.Types.ObjectId;
  contentType: string;
}

export interface FranchiseRecord {
  _id: mongoose.Types.ObjectId;
  name: string;
  storeCode: string;
  description?: string;
  address?: string;
  phone?: string;
  storeType: StoreType;
  ownerName?: string;
  ownerPhone?: string;
  ownerEmail?: string;
  logo?: FranchiseLogo;
  shifts: StoreShift[];
  positions: string[];
  salaryCycleType?: 'calendar_month' | 'custom';
  salaryCycleStartDay?: number;
  salaryCycleEndDay?: number;
  salaryCycleConfiguredAt?: Date;
  isActive: boolean;
  archivedAt?: Date;
  createdBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const shiftSchema = new Schema<StoreShift>(
  {
    id: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    startTime: { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
    endTime: { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false },
);

const franchiseSchema = new Schema<FranchiseRecord>(
  {
    name: { type: String, required: true, trim: true },
    storeCode: { type: String, required: true, unique: true, trim: true, uppercase: true },
    description: { type: String, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    storeType: { type: String, enum: ['company', 'franchise'], default: 'franchise' },
    ownerName: { type: String, trim: true },
    ownerPhone: { type: String, trim: true },
    ownerEmail: { type: String, lowercase: true, trim: true },
    logo: {
      type: new Schema<FranchiseLogo>(
        {
          fileId: { type: Schema.Types.ObjectId, required: true },
          contentType: { type: String, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
    shifts: { type: [shiftSchema], default: [] },
    positions: { type: [String], default: () => [...DEFAULT_POSITION_OPTIONS] },
    salaryCycleType: { type: String, enum: ['calendar_month', 'custom'] },
    salaryCycleStartDay: { type: Number, min: 1, max: 31 },
    salaryCycleEndDay: { type: Number, min: 1, max: 31 },
    salaryCycleConfiguredAt: { type: Date },
    isActive: { type: Boolean, default: true },
    archivedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, autoIndex: false },
);

franchiseSchema.index({ createdBy: 1 });
franchiseSchema.index({ isActive: 1 });
franchiseSchema.index({ storeType: 1, isActive: 1 });

export const Franchise =
  (mongoose.models.Franchise as mongoose.Model<FranchiseRecord> | undefined) ??
  mongoose.model<FranchiseRecord>('Franchise', franchiseSchema);