import { Router } from 'express';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { Franchise } from '../models/Franchise.js';
import { User } from '../models/User.js';
import { WeeklyRoster } from '../models/WeeklyRoster.js';
import { DEFAULT_POSITION_OPTIONS } from '../utils/employeePositions.js';
import { decodeBase64Upload, detectAllowedUploadType, getBucket } from '../utils/fileUpload.js';
import { getCycleRange, isValidPeriod, resolveCycleSettings } from '../utils/salaryCycle.js';
import { authorizeStore } from '../utils/storeAccess.js';
import { bodyRecord, isFranchiseAdmin } from '../utils/franchiseRoute.js';
import { byUser, rateLimitMiddleware, rateLimits } from '../utils/rateLimit.js';

const uploadLimiter = rateLimitMiddleware('upload', rateLimits.upload, byUser);

export const franchiseStoreConfigRouter = Router();
const router = franchiseStoreConfigRouter;
const MAX_LOGO_SIZE = 2 * 1024 * 1024;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SHIFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ALLOWED_LOGO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function getStoreId(request: Request, response: Response) {
  const body = bodyRecord(request);
  const queryId = request.query.storeId ?? request.query.franchiseId;
  const storeId = typeof queryId === 'string' ? queryId : body.storeId ?? body.franchiseId;
  return authorizeStore(storeId, request.auth!.id, response);
}

router.get('/stores/branding', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const store = await Franchise.findById(storeId).select('name logo').lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  response.json({ store: { name: store.name, hasLogo: Boolean(store.logo?.fileId) } });
});

router.put('/stores/branding', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const name = typeof bodyRecord(request).name === 'string' ? (bodyRecord(request).name as string).trim() : '';
  if (!name || name.length > 100) { response.status(400).json({ message: 'Enter a valid store name.' }); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const store = await Franchise.findOneAndUpdate({ _id: storeId }, { $set: { name } }, { new: true, runValidators: true }).lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  response.json({ message: 'Store name updated.', store: { name: store.name } });
});

router.get('/stores/logo', requireAuth, uploadLimiter, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const store = await Franchise.findById(storeId).select('logo').lean();
  if (!store?.logo?.fileId) { response.status(404).json({ message: 'Logo not found.' }); return; }
  const stream = getBucket('storeLogos').openDownloadStream(store.logo.fileId);
  stream.once('error', () => {
    if (!response.headersSent) response.status(404).json({ message: 'Logo could not be read.' });
    else response.destroy();
  });
  response.setHeader('Cache-Control', 'private, max-age=300');
  response.setHeader('Content-Type', store.logo.contentType);
  stream.pipe(response);
});

router.post('/stores/logo', requireAuth, uploadLimiter, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const body = bodyRecord(request);
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const encoded = body.base64;
  const decoded = decodeBase64Upload(encoded, MAX_LOGO_SIZE);
  if (!decoded) {
    const raw = typeof encoded === 'string' ? encoded.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '') : '';
    const tooLarge = raw.length > Math.ceil(MAX_LOGO_SIZE / 3) * 4;
    response.status(tooLarge ? 413 : 400).json({ message: tooLarge ? 'Logo must be 2 MB or smaller.' : 'Logo request is invalid.' });
    return;
  }
  const contentType = detectAllowedUploadType(decoded);
  if (!contentType || !ALLOWED_LOGO_TYPES.has(contentType)) {
    response.status(400).json({ message: 'Logo contents must be a valid PNG, JPEG, or WEBP image.' });
    return;
  }
  const target = await Franchise.findById(storeId);
  if (!target) { response.status(404).json({ message: 'Store not found.' }); return; }
  const bucket = getBucket('storeLogos');
  const previousFileId = target.logo?.fileId;
  const upload = bucket.openUploadStream(`${storeId}-logo`, { contentType });
  await new Promise<void>((resolve, reject) => {
    upload.once('error', reject);
    upload.once('finish', resolve);
    upload.end(decoded);
  });
  try {
    target.logo = { fileId: upload.id as mongoose.Types.ObjectId, contentType };
    await target.save();
  } catch (error) {
    await bucket.delete(upload.id).catch(() => undefined);
    throw error;
  }
  if (previousFileId) await bucket.delete(previousFileId).catch(() => undefined);
  response.json({ message: 'Logo uploaded successfully.' });
});

router.delete('/stores/logo', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const target = await Franchise.findById(storeId);
  if (!target) { response.status(404).json({ message: 'Store not found.' }); return; }
  const previousFileId = target.logo?.fileId;
  target.logo = undefined;
  await target.save();
  if (previousFileId) await getBucket('storeLogos').delete(previousFileId).catch(() => undefined);
  response.json({ message: 'Logo removed.' });
});

router.get('/stores/cycle', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const period = typeof request.query.period === 'string' ? request.query.period : '';
  if (!isValidPeriod(period)) { response.status(400).json({ message: 'A valid period is required.' }); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const store = await Franchise.findById(storeId).select('salaryCycleType salaryCycleStartDay salaryCycleEndDay salaryCycleConfiguredAt').lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  const settings = resolveCycleSettings(store);
  response.json({ cycle: { configured: Boolean(store.salaryCycleConfiguredAt), type: settings.cycleType, startDay: settings.startDay, endDay: settings.endDay, ...getCycleRange(period, settings.cycleType, settings.startDay) } });
});

router.put('/stores/cycle', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const body = bodyRecord(request);
  const cycleType = body.cycleType;
  const startDay = cycleType === 'calendar_month' ? 1 : body.startDay;
  if ((cycleType !== 'calendar_month' && cycleType !== 'custom') || (cycleType === 'custom' && (!Number.isInteger(startDay) || Number(startDay) < 2 || Number(startDay) > 28))) {
    response.status(400).json({ message: 'Choose a valid cycle type and a custom start day from 2 to 28.' });
    return;
  }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const saved = await Franchise.findOneAndUpdate({ _id: storeId }, { $set: {
    salaryCycleType: cycleType,
    salaryCycleStartDay: startDay,
    salaryCycleEndDay: cycleType === 'calendar_month' ? 31 : Number(startDay) - 1,
    salaryCycleConfiguredAt: new Date(),
  } }, { new: true, runValidators: true }).lean();
  if (!saved) { response.status(404).json({ message: 'Store not found.' }); return; }
  response.json({ message: 'Salary cycle updated.', cycle: { startDay: saved.salaryCycleStartDay, endDay: saved.salaryCycleEndDay } });
});

router.get('/stores/positions', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const store = await Franchise.findById(storeId).select('positions').lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  response.json({ positions: store.positions ?? DEFAULT_POSITION_OPTIONS });
});

router.put('/stores/positions', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const body = bodyRecord(request);
  if (!Array.isArray(body.positions) || body.positions.length > 30) {
    response.status(400).json({ message: 'A valid store and up to 30 positions are required.' }); return;
  }
  const positions = body.positions.map((position) => typeof position === 'string' ? position.trim() : '');
  if (positions.some((position) => !position || position.length > 60)) { response.status(400).json({ message: 'Each position must be 1 to 60 characters.' }); return; }
  if (new Set(positions.map((position) => position.toLowerCase())).size !== positions.length) { response.status(409).json({ message: 'Position names must be unique within this store.' }); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const store = await Franchise.findById(storeId).select('positions');
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  const removed = (store.positions ?? DEFAULT_POSITION_OPTIONS).filter((position) => !positions.some((nextPosition) => nextPosition.toLowerCase() === position.toLowerCase()));
  if (removed.length && await User.exists({ franchises: storeId, role: 'employee', position: { $in: removed } })) {
    response.status(409).json({ message: 'A position is assigned to an employee. Reassign those employees before removing it.' }); return;
  }
  store.positions = positions;
  await store.save();
  response.json({ message: 'Position options saved.', positions: store.positions });
});

router.get('/stores/shifts', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  const store = await Franchise.findById(storeId).select('shifts').lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  response.json({ shifts: store.shifts ?? [] });
});

router.put('/stores/shifts', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const body = bodyRecord(request);
  if (!Array.isArray(body.shifts) || body.shifts.length > 20) { response.status(400).json({ message: 'A valid store and up to 20 shifts are required.' }); return; }
  const shifts = body.shifts.map((item) => {
    const shift = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return { id: typeof shift.id === 'string' ? shift.id.trim() : '', name: typeof shift.name === 'string' ? shift.name.trim() : '', startTime: typeof shift.startTime === 'string' ? shift.startTime : '', endTime: typeof shift.endTime === 'string' ? shift.endTime : '' };
  });
  if (shifts.some((shift) => !SHIFT_ID_PATTERN.test(shift.id) || !shift.name || shift.name.length > 40 || !TIME_PATTERN.test(shift.startTime) || !TIME_PATTERN.test(shift.endTime))) {
    response.status(400).json({ message: 'Each shift needs a name and valid start/end times.' }); return;
  }
  if (new Set(shifts.map((shift) => shift.id)).size !== shifts.length) { response.status(400).json({ message: 'Shift IDs must be unique.' }); return; }
  if (new Set(shifts.map((shift) => shift.name.toLowerCase())).size !== shifts.length) { response.status(400).json({ message: 'Shift names must be unique for this store.' }); return; }
  const storeId = await getStoreId(request, response);
  if (!storeId) return;
  if (!mongoose.isValidObjectId(request.auth!.id)) { response.status(400).json({ message: 'A valid authenticated user is required.' }); return; }
  const store = await Franchise.findById(storeId).select('shifts');
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  const nextIds = new Set(shifts.map((shift) => shift.id));
  const removed = (store.shifts ?? []).map((shift) => shift.id).filter((id) => !nextIds.has(id));
  if (removed.length && await WeeklyRoster.exists({ franchise: storeId, 'entries.days.shift': { $in: removed } })) {
    response.status(409).json({ message: 'A shift is used in a saved weekly roster. Change those rosters before removing it.' }); return;
  }
  store.shifts = shifts;
  await store.save();
  response.json({ message: 'Store shifts saved.', shifts: store.shifts });
});
