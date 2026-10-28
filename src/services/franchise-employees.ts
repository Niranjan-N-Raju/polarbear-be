import { type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { User, type UserDocumentFile, type UserRecord } from '../models/User.js';
import { decryptUserFields } from '../utils/crypto.js';
import { bodyRecord, stringQuery } from '../utils/franchiseRoute.js';
import { authorizeStore, isDateValue } from '../utils/storeAccess.js';
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const documentFields = { aadhar: 'aadharDocument', pan: 'panDocument' } as const;
export type DocumentType = keyof typeof documentFields;
export type UserWithDocuments = mongoose.HydratedDocument<UserRecord> & { aadharDocument?: UserDocumentFile; panDocument?: UserDocumentFile; };
export function pageValue(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}
export function getDocumentType(value: string): DocumentType | null {
  return value === 'aadhar' || value === 'pan' ? value : null;
}
export function isAdultDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setFullYear(cutoff.getFullYear() - 18);
  return date <= cutoff;
}
export const INTERNAL_USER_FIELDS = ['password', 'sessionVersion', 'createdBy', '__v'] as const;
export function documentSummary(value: unknown) {
  if (!value || typeof value !== 'object') return value;
  const { fileName, contentType, size } = value as Record<string, unknown>;
  return { fileName, contentType, size };
}
export function safeUser<T extends Record<string, unknown>>(user: T): T {
  for (const field of INTERNAL_USER_FIELDS) delete user[field];
  for (const field of ['aadharDocument', 'panDocument'] as const) {
    if (user[field]) (user as Record<string, unknown>)[field] = documentSummary(user[field]);
  }
  return decryptUserFields(user);
}
export async function resolveStore(request: Request, response: Response) {
  const body = bodyRecord(request);
  const assigned = Array.isArray(body.franchiseIds) && typeof body.franchiseIds[0] === 'string'
    ? body.franchiseIds[0]
    : undefined;
  const queryStore = stringQuery(request, 'storeId') ?? stringQuery(request, 'franchiseId');
  let id: unknown = queryStore ?? (typeof body.storeId === 'string' ? body.storeId : assigned);
  if (!id) {
    const authUser = await User.findById(request.auth!.id).select('franchises').lean();
    const ownStore = authUser?.franchises?.[0];
    if (ownStore) id = String(ownStore);
  }
  // Express 5 re-parses req.query on every access, so the id is passed directly rather than written back.
  return authorizeStore(id, request.auth!.id, response);
}
export async function targetForStore(id: string, storeId: mongoose.Types.ObjectId) {
  if (!mongoose.isValidObjectId(id)) return null;
  const user = await User.findOne({ _id: id, role: 'employee', franchises: storeId });
  return user;
}
export function parseEmployee(body: Record<string, unknown>, requireName = true): { value?: Record<string, unknown>; error?: string; } {
  if (requireName && (typeof body.name !== 'string' || !body.name.trim())) return { error: 'Name is required.' };
  if (typeof body.name === 'string' && body.name.trim().length === 0) return { error: 'Name is required.' };
  if (typeof body.name === 'string' && body.name.trim().length > 100) return { error: 'Name must be 100 characters or fewer.' };
  if (body.phone !== undefined && body.phone !== '' && (typeof body.phone !== 'string' || !/^\d{10}$/.test(body.phone.trim()))) {
    return { error: 'Phone number must be exactly 10 digits.' };
  }
  if (body.emergencyContactPhone !== undefined && body.emergencyContactPhone !== '' && (typeof body.emergencyContactPhone !== 'string' || !/^\d{10}$/.test(body.emergencyContactPhone.trim()))) {
    return { error: 'Emergency contact number must be exactly 10 digits.' };
  }
  for (const field of ['actualDob', 'dobInRecords', 'dateOfJoining'] as const) {
    const value = body[field];
    if (value !== undefined && value !== '' && !isDateValue(value)) return { error: 'A valid date is required.' };
    if ((field === 'actualDob' || field === 'dobInRecords') && typeof value === 'string' && value && !isAdultDate(value)) {
      return { error: 'Employees must be at least 18 years old.' };
    }
  }
  if (body.employmentType !== undefined && body.employmentType !== '' && body.employmentType !== 'full_time' && body.employmentType !== 'part_time') {
    return { error: 'Invalid employment type.' };
  }
  if (body.salary !== undefined && body.salary !== null && (typeof body.salary !== 'number' || !Number.isFinite(body.salary) || body.salary < 0)) {
    return { error: 'Salary must be a valid non-negative amount.' };
  }
  const textFields = ['position', 'emergencyContactName', 'emergencyContactRelationship', 'aadharNumber', 'panNumber', 'bankAccountNumber', 'bankName', 'bankIfsc', 'bankBranch'];
  for (const field of textFields) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== 'string') return { error: `Invalid ${field}.` };
  }
  const value: Record<string, unknown> = {};
  if (typeof body.name === 'string') value.name = body.name.trim();
  for (const field of ['phone', ...textFields, 'employmentType', 'salary'] as const) {
    const input = body[field];
    if (input !== undefined) value[field] = typeof input === 'string' ? input.trim() : input;
  }
  for (const field of ['actualDob', 'dobInRecords', 'dateOfJoining'] as const) {
    if (body[field] !== undefined) value[field] = body[field] ? new Date(String(body[field])) : null;
  }
  if (typeof value.panNumber === 'string') value.panNumber = value.panNumber.toUpperCase();
  if (typeof value.bankIfsc === 'string') value.bankIfsc = value.bankIfsc.toUpperCase();
  return { value };
}
export const SAFE_DOCUMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
export const MAX_FILE_NAME_LENGTH = 100;
export function sanitizeFileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const base = value.split(/[\\/]/).pop() ?? '';
  // Strip control characters, quotes and header/path metacharacters.
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*;\\]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_FILE_NAME_LENGTH).join('').replace(/^\.+/, '');
}
export function contentDisposition(fileName: string): string {
  const safe = sanitizeFileName(fileName) || 'document';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/[%]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
