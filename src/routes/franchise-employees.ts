import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../middleware/auth.js';
import { Franchise } from '../models/Franchise.js';
import { User, type UserRecord, type UserDocumentFile } from '../models/User.js';
import { bodyRecord, isFranchiseAdmin, requireStore, stringQuery } from '../utils/franchiseRoute.js';
import { isDateValue } from '../utils/storeAccess.js';
import { decryptBuffer, decryptUserFields, encryptBuffer } from '../utils/crypto.js';
import { decodeBase64Upload, detectAllowedUploadType, getBucket } from '../utils/fileUpload.js';
import { DEFAULT_POSITION_OPTIONS } from '../utils/employeePositions.js';

export const franchiseEmployeesRouter = Router();
const router = franchiseEmployeesRouter;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const documentFields = { aadhar: 'aadharDocument', pan: 'panDocument' } as const;
type DocumentType = keyof typeof documentFields;
type UserWithDocuments = mongoose.HydratedDocument<UserRecord> & { aadharDocument?: UserDocumentFile; panDocument?: UserDocumentFile };

function escapeRegex(value: string) { return value.split('').map((c) => '.*+?^${}()|[]\\'.includes(c) ? String.fromCharCode(92) + c : c).join(''); }
function pageValue(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}
function getDocumentType(value: string): DocumentType | null {
  return value === 'aadhar' || value === 'pan' ? value : null;
}
function isAdultDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setFullYear(cutoff.getFullYear() - 18);
  return date <= cutoff;
}
const INTERNAL_USER_FIELDS = ['password', 'sessionVersion', 'createdBy', '__v'] as const;
function documentSummary(value: unknown) {
  if (!value || typeof value !== 'object') return value;
  const { fileName, contentType, size } = value as Record<string, unknown>;
  return { fileName, contentType, size };
}
function safeUser<T extends Record<string, unknown>>(user: T): T {
  for (const field of INTERNAL_USER_FIELDS) delete user[field];
  for (const field of ['aadharDocument', 'panDocument'] as const) {
    if (user[field]) (user as Record<string, unknown>)[field] = documentSummary(user[field]);
  }
  return decryptUserFields(user);
}

async function resolveStore(request: Parameters<typeof requireStore>[0], response: Parameters<typeof requireStore>[1]) {
  const body = bodyRecord(request);
  const assigned = Array.isArray(body.franchiseIds) && typeof body.franchiseIds[0] === 'string'
    ? body.franchiseIds[0]
    : undefined;
  const queryStore = stringQuery(request, 'storeId') ?? stringQuery(request, 'franchiseId');
  const id = queryStore ?? (typeof body.storeId === 'string' ? body.storeId : assigned);
  if (id) request.query.storeId = id;
  else {
    const authUser = await User.findById(request.auth!.id).select('franchises').lean();
    const ownStore = authUser?.franchises?.[0];
    if (ownStore) request.query.storeId = String(ownStore);
  }
  return requireStore(request, response);
}

async function targetForStore(id: string, storeId: mongoose.Types.ObjectId) {
  if (!mongoose.isValidObjectId(id)) return null;
  const user = await User.findOne({ _id: id, role: 'employee', franchises: storeId });
  return user;
}

function parseEmployee(body: Record<string, unknown>, requireName = true): { value?: Record<string, unknown>; error?: string } {
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

router.get('/users', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  const status = stringQuery(request, 'status') ?? 'all';
  if (!['all', 'active', 'inactive'].includes(status)) { response.status(400).json({ message: 'Invalid user status.' }); return; }
  const query: Record<string, unknown> = { role: 'employee', franchises: storeId };
  if (status === 'active') query.isActive = { $ne: false };
  if (status === 'inactive') query.isActive = false;
  else if (status === 'all' && stringQuery(request, 'includeArchived') !== 'true') query.isActive = { $ne: false };
  const search = stringQuery(request, 'search')?.trim();
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: regex }, { phone: regex }];
  }
  const page = pageValue(request.query.page, 1);
  const limit = Math.min(500, pageValue(request.query.limit, 50));
  const [users, total, stores] = await Promise.all([
    User.find(query).select('-password').sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(query),
    Franchise.find({ _id: storeId }).select('_id name').lean(),
  ]);
  const storeName = stores[0]?.name ?? 'Unknown';
  response.json({
    users: users.map((user) => ({
      _id: String(user._id), name: user.name, email: user.email, phone: user.phone,
      position: user.position, employmentType: user.employmentType, salary: user.salary,
      role: user.role, isActive: user.isActive !== false, actualDob: user.actualDob,
      dateOfJoining: user.dateOfJoining, archivedAt: user.archivedAt,
      franchises: [{ _id: String(storeId), name: storeName }], createdAt: user.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

router.get('/users/:id', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  if (!mongoose.isValidObjectId(String(request.params.id))) { response.status(404).json({ message: 'User not found.' }); return; }
  const user = await User.findOne({ _id: String(request.params.id), role: 'employee', franchises: storeId }).select('-password').lean();
  if (!user) { response.status(404).json({ message: 'User not found.' }); return; }
  response.json({ user: safeUser({ ...user } as unknown as Record<string, unknown>) });
});

router.post('/users', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const body = bodyRecord(request);
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  const franchiseIds = Array.isArray(body.franchiseIds) ? body.franchiseIds.map(String) : [String(storeId)];
  if (franchiseIds.length !== 1 || franchiseIds[0] !== String(storeId)) { response.status(403).json({ message: 'You can only assign employees to your own store.' }); return; }
  const parsed = parseEmployee(body);
  if (parsed.error) { response.status(400).json({ message: parsed.error }); return; }
  const position = parsed.value?.position;
  if (typeof position === 'string' && position) {
    const store = await Franchise.findById(storeId).select('positions').lean();
    if (!(store?.positions ?? DEFAULT_POSITION_OPTIONS).includes(position)) { response.status(400).json({ message: 'Select a position configured for this store.' }); return; }
  }
  const email = `emp_${randomBytes(12).toString('hex')}@nologin.internal`;
  const user = await User.create({
    ...parsed.value, email, password: await bcrypt.hash(randomBytes(32).toString('hex'), 12),
    role: 'employee', isActive: true, createdBy: new mongoose.Types.ObjectId(request.auth!.id), franchises: [storeId],
  });
  response.status(201).json({ message: 'Employee created successfully.', user: { _id: String(user._id) } });
});

router.patch('/users/:id', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  const target = await targetForStore(String(request.params.id), storeId);
  if (!target) { response.status(404).json({ message: 'Employee not found.' }); return; }
  const body = bodyRecord(request);
  if (body.franchiseIds !== undefined && (!Array.isArray(body.franchiseIds) || body.franchiseIds.length !== 1 || String(body.franchiseIds[0]) !== String(storeId))) {
    response.status(403).json({ message: 'You can only assign employees to your own store.' }); return;
  }
  const parsed = parseEmployee(body, false);
  if (parsed.error) { response.status(400).json({ message: parsed.error }); return; }
  const update = { ...parsed.value };
  if (body.position !== undefined && typeof body.position === 'string' && body.position && body.position !== target.position) {
    const store = await Franchise.findById(storeId).select('positions').lean();
    if (!(store?.positions ?? DEFAULT_POSITION_OPTIONS).includes(body.position)) { response.status(400).json({ message: 'Select a position configured for this store.' }); return; }
  }
  if (Object.keys(update).length === 0) { response.status(400).json({ message: 'No fields to update.' }); return; }
  Object.assign(target, update);
  const saved = await target.save();
  const result = safeUser(saved.toObject() as unknown as Record<string, unknown>);
  response.json({ message: 'User updated.', user: result });
});

router.put('/users/:id', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  const target = await targetForStore(String(request.params.id), storeId);
  if (!target) { response.status(404).json({ message: 'Employee not found.' }); return; }
  target.isActive = true;
  target.archivedAt = undefined;
  target.sessionVersion = (target.sessionVersion ?? 0) + 1;
  await target.save();
  response.json({ message: 'Employee unarchived.' });
});

router.delete('/users/:id', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  if (String(request.params.id) === request.auth!.id) { response.status(400).json({ message: 'You cannot delete your own account.' }); return; }
  const target = await targetForStore(String(request.params.id), storeId);
  if (!target) { response.status(404).json({ message: 'Employee not found.' }); return; }
  const exitDate = bodyRecord(request).exitDate;
  let archivedAt = new Date();
  if (exitDate !== undefined) {
    if (!isDateValue(exitDate)) { response.status(400).json({ message: 'A valid exit date is required.' }); return; }
    const today = new Date();
    const todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (exitDate > todayValue) { response.status(400).json({ message: 'Exit date cannot be in the future.' }); return; }
    archivedAt = new Date(`${exitDate}T00:00:00.000Z`);
    archivedAt.setUTCDate(archivedAt.getUTCDate() + 1);
  }
  target.isActive = false;
  target.archivedAt = archivedAt;
  target.sessionVersion = (target.sessionVersion ?? 0) + 1;
  await target.save();
  response.json({ message: 'Employee archived.' });
});

router.post('/users/:id/documents/:documentType', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const type = getDocumentType(String(request.params.documentType));
  if (!type) { response.status(400).json({ message: 'Invalid document type.' }); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  const body = bodyRecord(request);
  const bytes = decodeBase64Upload(body.base64 ?? body.file ?? body.data, MAX_FILE_SIZE);
  if (!bytes) { response.status(400).json({ message: 'Document request is invalid or too large.' }); return; }
  const contentType = detectAllowedUploadType(bytes);
  if (!contentType || !['application/pdf', 'image/jpeg', 'image/png'].includes(contentType)) {
    response.status(400).json({ message: 'Only valid PDF, JPEG, and PNG files are allowed.' }); return;
  }
  const target = await targetForStore(String(request.params.id), storeId) as UserWithDocuments | null;
  if (!target) { response.status(404).json({ message: 'User not found.' }); return; }
  const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim().slice(0, 255) : `${type}.${contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'jpg'}`;
  const field = documentFields[type];
  const previous = target[field];
  const bucket = getBucket('employeeDocuments');
  const upload = bucket.openUploadStream(`${String(request.params.id)}-${type}`, {
    contentType: 'application/octet-stream', metadata: { userId: String(request.params.id), documentType: type, encrypted: true },
  });
  await new Promise<void>((resolve, reject) => { upload.once('error', reject); upload.once('finish', resolve); upload.end(encryptBuffer(bytes)); });
  try {
    target.set(field, { fileId: upload.id, fileName, contentType, size: bytes.length });
    await target.save();
  } catch (error) {
    await bucket.delete(upload.id).catch(() => undefined);
    throw error;
  }
  if (previous?.fileId) await bucket.delete(previous.fileId).catch(() => undefined);
  response.json({ document: { fileName, contentType, size: bytes.length } });
});

router.get('/users/:id/documents/:documentType', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const type = getDocumentType(String(request.params.documentType));
  if (!type) { response.status(400).json({ message: 'Invalid document type.' }); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  if (!mongoose.isValidObjectId(String(request.params.id))) { response.status(404).json({ message: 'Document not found.' }); return; }
  const user = await User.findOne({ _id: String(request.params.id), role: 'employee', franchises: storeId }).select(documentFields[type]).lean();
  const metadata = user?.[documentFields[type]] as UserDocumentFile | undefined;
  if (!metadata?.fileId) { response.status(404).json({ message: 'Document not found.' }); return; }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of getBucket('employeeDocuments').openDownloadStream(metadata.fileId)) chunks.push(Buffer.from(chunk));
    const bytes = decryptBuffer(Buffer.concat(chunks));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', metadata.contentType);
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(metadata.fileName)}`);
    response.send(bytes);
  } catch {
    response.status(404).json({ message: 'Document could not be read.' });
  }
});

router.delete('/users/:id/documents/:documentType', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const type = getDocumentType(String(request.params.documentType));
  if (!type) { response.status(400).json({ message: 'Invalid document type.' }); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  const target = await targetForStore(String(request.params.id), storeId) as UserWithDocuments | null;
  const field = documentFields[type];
  const metadata = target?.[field];
  if (!target || !metadata?.fileId) { response.status(404).json({ message: 'Document not found.' }); return; }
  target.set(field, undefined);
  await target.save();
  await getBucket('employeeDocuments').delete(metadata.fileId).catch(() => undefined);
  response.json({ message: 'Document removed.' });
});
