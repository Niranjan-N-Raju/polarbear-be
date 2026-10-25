import mongoose, { Schema } from 'mongoose';
import { ENCRYPTED_USER_FIELDS, encryptField } from '../utils/crypto.js';

export interface UserDocumentFile {
  fileId: mongoose.Types.ObjectId;
  fileName: string;
  contentType: string;
  size: number;
}

const documentFileSchema = new Schema<UserDocumentFile>(
  {
    fileId: { type: Schema.Types.ObjectId, required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false },
);

export type UserRole = 'admin' | 'sub_admin' | 'franchise_admin' | 'employee';

export interface UserRecord {
  _id: mongoose.Types.ObjectId;
  email: string;
  password?: string;
  name: string;
  role: UserRole;
  isActive?: boolean;
  sessionVersion?: number;
  archivedAt?: Date;
  franchises: mongoose.Types.ObjectId[];
  createdBy?: mongoose.Types.ObjectId;
  phone?: string;
  position?: string;
  employmentType?: 'full_time' | 'part_time';
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelationship?: string;
  actualDob?: Date;
  dobInRecords?: Date;
  aadharNumber?: string;
  panNumber?: string;
  salary?: number;
  bankAccountNumber?: string;
  bankName?: string;
  bankIfsc?: string;
  bankBranch?: string;
  aadharDocument?: UserDocumentFile;
  panDocument?: UserDocumentFile;
  dateOfJoining?: Date;
  createdAt?: Date;
}

const userSchema = new Schema<UserRecord>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ['admin', 'sub_admin', 'franchise_admin', 'employee'],
      default: 'employee',
    },
    isActive: { type: Boolean, default: true },
    sessionVersion: { type: Number, default: 0, min: 0 },
    archivedAt: { type: Date },
    franchises: [{ type: Schema.Types.ObjectId, ref: 'Franchise' }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    phone: { type: String, trim: true },
    position: { type: String, trim: true },
    employmentType: { type: String, enum: ['full_time', 'part_time'] },
    emergencyContactName: { type: String, trim: true },
    emergencyContactPhone: { type: String, trim: true },
    emergencyContactRelationship: { type: String, trim: true },
    actualDob: { type: Date },
    dobInRecords: { type: Date },
    aadharNumber: { type: String, trim: true },
    panNumber: { type: String, trim: true },
    salary: { type: Number, min: 0 },
    bankAccountNumber: { type: String, trim: true },
    bankName: { type: String, trim: true },
    bankIfsc: { type: String, trim: true },
    bankBranch: { type: String, trim: true },
    aadharDocument: { type: documentFileSchema },
    panDocument: { type: documentFileSchema },
    dateOfJoining: { type: Date },
  },
  { timestamps: true, autoIndex: false },
);

userSchema.index({ franchises: 1 });
userSchema.index({ createdBy: 1 });
userSchema.index({ role: 1 });
userSchema.index({ createdBy: 1, role: 1 });

userSchema.pre('save', function encryptSensitiveFields() {
  const doc = this as unknown as Record<string, unknown> & { isModified(path: string): boolean };
  for (const field of ENCRYPTED_USER_FIELDS) {
    const value = doc[field];
    if (doc.isModified(field) && typeof value === 'string' && value) {
      doc[field] = encryptField(value);
    }
  }
});

export const User =
  (mongoose.models.User as mongoose.Model<UserRecord> | undefined) ??
  mongoose.model<UserRecord>('User', userSchema);