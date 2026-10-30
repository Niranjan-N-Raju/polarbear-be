import bcrypt from 'bcryptjs';
import type { NextFunction } from 'express';
import { type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { Franchise } from '../models/Franchise.js';
import { User, type UserDocumentFile } from '../models/User.js';
import { contentDisposition, documentFields, getDocumentType, MAX_FILE_SIZE, pageValue, parseEmployee, resolveStore, SAFE_DOCUMENT_TYPES, safeUser, sanitizeFileName, targetForStore, UserWithDocuments } from '../services/franchise-employees.js';
import { decryptBuffer, encryptBuffer } from '../utils/crypto.js';
import { DEFAULT_POSITION_OPTIONS } from '../utils/employeePositions.js';
import { decodeBase64Upload, detectAllowedUploadType, getBucket } from '../utils/fileUpload.js';
import { bodyRecord, isFranchiseAdmin, stringQuery } from '../utils/franchiseRoute.js';
import { clampPage, escapeRegex, isSearchTooLong, SEARCH_TOO_LONG_MESSAGE } from '../utils/listQuery.js';
import { isDateValue } from '../utils/storeAccess.js';
import { auditMutation } from '../utils/businessLimits.js';
import { addDaysToDateValue, businessDateValue, businessDayStart } from '../utils/dateUtils.js';
export async function getUsers(request: Request, response: Response, next: NextFunction) {
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
  if (isSearchTooLong(search)) { response.status(400).json({ message: SEARCH_TOO_LONG_MESSAGE }); return; }
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ name: regex }, { phone: regex }, { employeeCode: regex }];
  }
  const page = clampPage(pageValue(request.query.page, 1));
  const limit = Math.min(500, pageValue(request.query.limit, 50));
  const [users, total, stores] = await Promise.all([
    User.find(query).select('-password').sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(query),
    Franchise.find({ _id: storeId }).select('_id name').lean(),
  ]);
  const storeName = stores[0]?.name ?? 'Unknown';
  response.json({
    users: users.map((user) => ({
      _id: String(user._id), name: user.name, employeeCode: user.employeeCode, email: user.email, phone: user.phone,
      position: user.position, employmentType: user.employmentType, salary: user.salary,
      role: user.role, isActive: user.isActive !== false, actualDob: user.actualDob,
      dateOfJoining: user.dateOfJoining, archivedAt: user.archivedAt,
      franchises: [{ _id: String(storeId), name: storeName }], createdAt: user.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function getUsersId(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  if (!mongoose.isValidObjectId(String(request.params.id))) { response.status(404).json({ message: 'User not found.' }); return; }
  const user = await User.findOne({ _id: String(request.params.id), role: 'employee', franchises: storeId }).select('-password').lean();
  if (!user) { response.status(404).json({ message: 'User not found.' }); return; }
  response.json({ user: safeUser({ ...user } as unknown as Record<string, unknown>) });
}

export async function postUsers(request: Request, response: Response, next: NextFunction) {
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
  // Audit field names only; employee PII values are never logged.
  auditMutation(request, 'employee.created', { storeId, targetId: user._id, after: { fields: Object.keys(parsed.value ?? {}) } });
  response.status(201).json({ message: 'Employee created successfully.', user: { _id: String(user._id), employeeCode: user.employeeCode } });
}

export async function patchUsersId(request: Request, response: Response, next: NextFunction) {
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
  auditMutation(request, 'employee.updated', { storeId, targetId: target._id, after: { fields: Object.keys(update) } });
  const result = safeUser(saved.toObject() as unknown as Record<string, unknown>);
  response.json({ message: 'User updated.', user: result });
}

export async function putUsersId(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  const target = await targetForStore(String(request.params.id), storeId);
  if (!target) { response.status(404).json({ message: 'Employee not found.' }); return; }
  target.isActive = true;
  target.archivedAt = undefined;
  target.sessionVersion = (target.sessionVersion ?? 0) + 1;
  await target.save();
  auditMutation(request, 'employee.unarchived', { storeId, targetId: target._id, after: { isActive: true } });
  response.json({ message: 'Employee unarchived.' });
}

export async function deleteUsersId(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  if (String(request.params.id) === request.auth!.id) { response.status(400).json({ message: 'You cannot delete your own account.' }); return; }
  const target = await targetForStore(String(request.params.id), storeId);
  if (!target) { response.status(404).json({ message: 'Employee not found.' }); return; }
  const exitDate = bodyRecord(request).exitDate;
  const todayValue = businessDateValue();
  // archivedAt is the first inactive instant; without an exit date, today (the archive day) is still
  // worked and paid, so the employee becomes inactive from the start of the next India business day.
  let archivedAt = businessDayStart(addDaysToDateValue(todayValue, 1));
  if (exitDate !== undefined) {
    if (!isDateValue(exitDate)) { response.status(400).json({ message: 'A valid exit date is required.' }); return; }
    if (exitDate > todayValue) { response.status(400).json({ message: 'Exit date cannot be in the future.' }); return; }
    archivedAt = businessDayStart(addDaysToDateValue(exitDate, 1));
  }
  target.isActive = false;
  target.archivedAt = archivedAt;
  target.sessionVersion = (target.sessionVersion ?? 0) + 1;
  await target.save();
  auditMutation(request, 'employee.archived', { storeId, targetId: target._id, after: { archivedAt: archivedAt.toISOString(), exitDate: typeof exitDate === 'string' ? exitDate : undefined } });
  response.json({ message: 'Employee archived.' });
}

export async function postUsersIdDocumentsDocumentType(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const type = getDocumentType(String(request.params.documentType));
  if (!type) { response.status(400).json({ message: 'Invalid document type.' }); return; }
  const storeId = await resolveStore(request, response);
  if (!storeId) return;
  const body = bodyRecord(request);
  const bytes = decodeBase64Upload(body.base64 ?? body.file ?? body.data, MAX_FILE_SIZE);
  if (!bytes) { response.status(400).json({ message: 'Document request is invalid or larger than 3 MB.' }); return; }
  const contentType = detectAllowedUploadType(bytes);
  if (!contentType || !SAFE_DOCUMENT_TYPES.has(contentType)) {
    response.status(400).json({ message: 'Only valid PDF, JPEG, and PNG files are allowed.' }); return;
  }
  const target = await targetForStore(String(request.params.id), storeId) as UserWithDocuments | null;
  if (!target) { response.status(404).json({ message: 'User not found.' }); return; }
  const fileName = sanitizeFileName(body.fileName) || `${type}.${contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'jpg'}`;
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
  auditMutation(request, 'document.uploaded', { storeId, targetId: request.params.id, after: { documentType: type, contentType, size: bytes.length, replaced: Boolean(previous?.fileId) } });
  response.json({ document: { fileName, contentType, size: bytes.length } });
}

export async function getUsersIdDocumentsDocumentType(request: Request, response: Response, next: NextFunction) {
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
    auditMutation(request, 'document.read', { storeId, targetId: request.params.id, after: { documentType: type } });
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', SAFE_DOCUMENT_TYPES.has(metadata.contentType) ? metadata.contentType : 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', contentDisposition(metadata.fileName));
    response.send(bytes);
  } catch {
    response.status(404).json({ message: 'Document could not be read.' });
  }
}

export async function deleteUsersIdDocumentsDocumentType(request: Request, response: Response, next: NextFunction) {
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
  auditMutation(request, 'document.deleted', { storeId, targetId: request.params.id, before: { documentType: type } });
  response.json({ message: 'Document removed.' });
}
