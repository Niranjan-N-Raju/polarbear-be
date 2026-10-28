import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Attendance, type AttendanceRecord } from '../models/Attendance.js';
import { AttendanceRemoval } from '../models/AttendanceRemoval.js';
import { Franchise } from '../models/Franchise.js';
import { User } from '../models/User.js';
import { WeeklyRoster } from '../models/WeeklyRoster.js';
import { MAX_ENTRIES, mondayOnOrBefore, serializeRoster, Shift, STATUSES, validMonday, weekDates } from '../services/franchise-attendance.js';
import { auditMutation } from '../utils/businessLimits.js';
import { businessDateValue, exceedsMaxRange, localDateValue, MAX_RANGE_DAYS } from '../utils/dateUtils.js';
import { isEmployeeActiveOn } from '../utils/employeeStatus.js';
import { bodyRecord, isFranchiseAdmin, requireStore, stringQuery } from '../utils/franchiseRoute.js';
import { isArchivedStore, isDateValue } from '../utils/storeAccess.js';
export async function getAttendance(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const date = stringQuery(request, 'date');
  const from = stringQuery(request, 'from');
  const to = stringQuery(request, 'to');
  const hasDate = isDateValue(date);
  const hasRange = isDateValue(from) && isDateValue(to) && from <= to;
  if (!hasDate && !hasRange) {
    response.status(400).json({ message: 'A valid store and date range are required.' });
    return;
  }
  if (!hasDate && exceedsMaxRange(from!, to!)) {
    response.status(400).json({ message: `Date range cannot exceed ${MAX_RANGE_DAYS} days.` });
    return;
  }

  // GET is treated as read-only by authorizeStore, so explicitly avoid materializing rows for archived stores.
  const storeState = hasRange ? await Franchise.findById(storeId).select('isActive archivedAt').lean() : null;
  // Roster defaults are materialized only for elapsed business dates (never the future), only for
  // employees active on that date, and never where an admin explicitly removed the mark.
  const today = businessDateValue();
  const defaultsTo = hasRange && to! < today ? to! : today;
  if (hasRange && storeState && !isArchivedStore(storeState) && from! <= defaultsTo) {
    const rosters = await WeeklyRoster.find({ franchise: storeId, 'entries.days.date': { $gte: from, $lte: defaultsTo } }).lean();
    const candidates = rosters.flatMap((roster) => roster.entries.flatMap((entry) => entry.days
      .filter((day) => day.date >= from! && day.date <= defaultsTo)
      .map((day) => ({ createdBy: roster.createdBy, employee: entry.employee, day }))));
    if (candidates.length) {
      const employeeIds = [...new Set(candidates.map((candidate) => String(candidate.employee)))];
      const [employees, removals] = await Promise.all([
        User.find({ _id: { $in: employeeIds }, role: 'employee', franchises: storeId })
          .select('_id dateOfJoining archivedAt isActive').lean(),
        AttendanceRemoval.find({ franchise: storeId, employee: { $in: employeeIds }, date: { $gte: from, $lte: defaultsTo } })
          .select('employee date').lean(),
      ]);
      const employeesById = new Map(employees.map((employee) => [String(employee._id), employee]));
      const removed = new Set(removals.map((removal) => `${String(removal.employee)}:${removal.date}`));
      const defaults = candidates
        .filter(({ employee, day }) => {
          const record = employeesById.get(String(employee));
          return Boolean(record) && isEmployeeActiveOn(record!, day.date) && !removed.has(`${String(employee)}:${day.date}`);
        })
        .map(({ createdBy, employee, day }) => ({
          updateOne: {
            filter: { franchise: storeId, employee, date: day.date },
            update: {
              $setOnInsert: {
                franchise: storeId,
                employee,
                date: day.date,
                status: (day.shift === 'off' ? 'Week Off' : 'Present') as AttendanceRecord['status'],
                comment: '',
                createdBy,
              }
            },
            upsert: true,
          },
        }));
      if (defaults.length) await Attendance.bulkWrite(defaults);
    }
  }

  const records = await Attendance.find({ franchise: storeId, ...(hasDate ? { date } : { date: { $gte: from, $lte: to } }) }).lean();
  response.json({ records: records.map((record) => ({ employeeId: String(record.employee), date: record.date, status: record.status as AttendanceRecord['status'], comment: record.comment ?? '' })) });
}

export async function putAttendance(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const body = bodyRecord(request);
  const date = body.date;
  const records = body.records;
  if (!isDateValue(date) || !Array.isArray(records)) { response.status(400).json({ message: 'A valid store, date, and records are required.' }); return; }
  if (records.length > MAX_ENTRIES) { response.status(400).json({ message: 'Too many attendance records.' }); return; }
  const inputs = records.map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : {});
  const employeeIds = inputs.map((record) => typeof record.employeeId === 'string' ? record.employeeId : '');
  if (employeeIds.some((id) => !mongoose.isValidObjectId(id))) { response.status(400).json({ message: 'Each employee must be valid.' }); return; }
  if (new Set(employeeIds).size !== employeeIds.length) { response.status(400).json({ message: 'Each employee can only be marked once per date.' }); return; }
  if (inputs.some((record) => !STATUSES.has(record.status as AttendanceRecord['status']))) { response.status(400).json({ message: 'Each attendance status must be valid.' }); return; }
  if (inputs.some((record) => typeof record.comment === 'string' && record.comment.length > 500)) { response.status(400).json({ message: 'Comments must be 500 characters or fewer.' }); return; }

  const employees = await User.find({ _id: { $in: employeeIds }, role: 'employee', franchises: storeId })
    .select('_id dateOfJoining archivedAt isActive').lean();
  const eligible = new Set(employees.filter((employee) => isEmployeeActiveOn(employee, date)).map((employee) => String(employee._id)));
  const savedRecords = inputs.filter((record) => eligible.has(record.employeeId as string));
  const skippedCount = employeeIds.length - savedRecords.length;
  if (!mongoose.isValidObjectId(request.auth!.id)) { response.status(400).json({ message: 'A valid authenticated user is required.' }); return; }
  const actor = new mongoose.Types.ObjectId(request.auth!.id);
  const savedIds = savedRecords.map((record) => new mongoose.Types.ObjectId(record.employeeId as string));
  const previous = savedIds.length
    ? await Attendance.find({ franchise: storeId, date, employee: { $in: savedIds } }).select('employee status').lean()
    : [];
  const operations = savedRecords.map((record) => ({
    updateOne: {
      filter: { franchise: storeId, employee: new mongoose.Types.ObjectId(record.employeeId as string), date },
      update: { $set: { status: record.status as AttendanceRecord['status'], comment: typeof record.comment === 'string' ? record.comment.trim() : '', createdBy: actor } },
      upsert: true,
    },
  }));
  if (operations.length) {
    await Attendance.bulkWrite(operations);
    // An explicit mark supersedes an earlier removal, so the roster default rules apply again.
    await AttendanceRemoval.deleteMany({ franchise: storeId, date, employee: { $in: savedIds } });
  }
  if (savedRecords.length) {
    auditMutation(request, 'attendance.marked', {
      storeId,
      before: { date, records: previous.map((record) => ({ employeeId: String(record.employee), status: record.status })) },
      after: { date, records: savedRecords.map((record) => ({ employeeId: record.employeeId, status: record.status })) },
    });
  }
  response.json({ message: skippedCount ? `Attendance saved for ${savedRecords.length} employee(s). ${skippedCount} employee(s) weren't active on this date and were skipped.` : 'Attendance saved successfully.', skippedCount });
}

export async function deleteAttendance(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const date = stringQuery(request, 'date');
  const employeeId = stringQuery(request, 'employeeId');
  if (!isDateValue(date) || !employeeId || !mongoose.isValidObjectId(employeeId)) { response.status(400).json({ message: 'A valid store, date, and employee are required.' }); return; }
  const deleted = await Attendance.findOneAndDelete({ franchise: storeId, employee: employeeId, date }).lean();
  if (!deleted) { response.status(404).json({ message: 'Attendance record not found.' }); return; }
  // Remember the removal so viewing attendance does not re-create the roster default for this day.
  await AttendanceRemoval.updateOne(
    { franchise: storeId, employee: new mongoose.Types.ObjectId(employeeId), date },
    {
      $setOnInsert: { franchise: storeId, employee: new mongoose.Types.ObjectId(employeeId), date },
      ...(mongoose.isValidObjectId(request.auth!.id) ? { $set: { createdBy: new mongoose.Types.ObjectId(request.auth!.id) } } : {}),
    },
    { upsert: true },
  );
  auditMutation(request, 'attendance.removed', { storeId, targetId: employeeId, before: { date, status: deleted.status } });
  response.json({ message: 'Attendance record removed.' });
}

export async function getAttendanceWeeklyRoster(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const weekStart = stringQuery(request, 'weekStart') ?? '';
  const from = stringQuery(request, 'from') ?? '';
  const to = stringQuery(request, 'to') ?? '';
  const hasRange = isDateValue(from) && isDateValue(to) && from <= to;
  if (!validMonday(weekStart) && !hasRange) { response.status(400).json({ message: 'A valid store and week start or date range are required.' }); return; }
  if (hasRange && exceedsMaxRange(from, to)) { response.status(400).json({ message: `Date range cannot exceed ${MAX_RANGE_DAYS} days.` }); return; }

  const firstWeek = hasRange ? mondayOnOrBefore(from) : weekStart;
  const lastWeek = hasRange ? mondayOnOrBefore(to) : weekStart;
  const weekStarts: string[] = [];
  for (let cursor = firstWeek; cursor <= lastWeek;) {
    weekStarts.push(cursor);
    const next = new Date(`${cursor}T00:00:00`);
    next.setDate(next.getDate() + 7);
    cursor = localDateValue(next);
  }
  const [rosters, store] = await Promise.all([
    WeeklyRoster.find({ franchise: storeId, weekStart: { $in: weekStarts } }).sort({ weekStart: 1 }).lean(),
    Franchise.findById(storeId).select('shifts').lean(),
  ]);
  const shifts = (store?.shifts ?? []) as Shift[];
  response.json({ shifts, rosters: rosters.map((roster) => serializeRoster(roster, shifts)), roster: hasRange || !rosters[0] ? null : serializeRoster(rosters[0], shifts) });
}

export async function putAttendanceWeeklyRoster(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const body = bodyRecord(request);
  const weekStart = typeof body.weekStart === 'string' ? body.weekStart : '';
  const entries = body.entries;
  if (!validMonday(weekStart) || !Array.isArray(entries) || entries.length > MAX_ENTRIES) { response.status(400).json({ message: 'A valid store, Monday week start, and roster entries are required.' }); return; }
  const dates = weekDates(weekStart);
  if (dates.length !== 7) { response.status(400).json({ message: 'The roster week must contain seven days.' }); return; }
  const inputEntries = entries.map((entry) => entry && typeof entry === 'object' ? entry as Record<string, unknown> : {});
  const employeeIds = inputEntries.map((entry) => typeof entry.employeeId === 'string' ? entry.employeeId : '');
  if (employeeIds.some((id) => !mongoose.isValidObjectId(id)) || new Set(employeeIds).size !== employeeIds.length) { response.status(400).json({ message: 'Each roster employee must be valid and listed once.' }); return; }
  for (const entry of inputEntries) {
    if (!Array.isArray(entry.days) || entry.days.length !== 7) { response.status(400).json({ message: 'Each employee must have one schedule for every day.' }); return; }
    const dayValues = entry.days.map((day) => day && typeof day === 'object' ? day as Record<string, unknown> : {});
    const entryDates = dayValues.map((day) => day.date);
    if (new Set(entryDates).size !== 7 || dates.some((date) => !entryDates.includes(date))) { response.status(400).json({ message: 'Roster dates must match the selected week.' }); return; }
    if (dayValues.some((day) => typeof day.shift !== 'string' || day.shift.length === 0 || day.shift.length > 80)) { response.status(400).json({ message: 'Choose a configured shift or mark the day off.' }); return; }
  }

  const store = await Franchise.findById(storeId).select('shifts').lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  const shifts = (store.shifts ?? []) as Shift[];
  const validShiftIds = new Set(shifts.map((shift) => shift.id));
  if (inputEntries.some((entry) => (entry.days as Array<Record<string, unknown>>).some((day) => day.shift !== 'off' && !validShiftIds.has(day.shift as string)))) { response.status(400).json({ message: 'Choose a configured shift or mark the day off.' }); return; }
  const employees = await User.find({ _id: { $in: employeeIds }, role: 'employee', franchises: storeId, isActive: { $ne: false } })
    .select('_id dateOfJoining isActive archivedAt').lean();
  if (employees.length !== employeeIds.length) { response.status(400).json({ message: 'Roster employees must be active employees assigned to this store.' }); return; }
  const byId = new Map(employees.map((employee) => [String(employee._id), employee]));
  for (const entry of inputEntries) {
    const employee = byId.get(entry.employeeId as string)!;
    if ((entry.days as Array<Record<string, unknown>>).some((day) => day.shift !== 'off' && !isEmployeeActiveOn(employee, day.date as string))) { response.status(400).json({ message: 'Cannot schedule an employee outside their active employment dates.' }); return; }
  }
  if (!mongoose.isValidObjectId(request.auth!.id)) { response.status(400).json({ message: 'A valid authenticated user is required.' }); return; }
  const rosterEntries = inputEntries.map((entry) => ({ employee: new mongoose.Types.ObjectId(entry.employeeId as string), days: (entry.days as Array<Record<string, unknown>>).map((day) => ({ date: day.date as string, shift: day.shift as string })) }));
  const previousRoster = await WeeklyRoster.findOneAndUpdate(
    { franchise: storeId, weekStart },
    { $set: { entries: rosterEntries }, $setOnInsert: { createdBy: new mongoose.Types.ObjectId(request.auth!.id) } },
    { new: false, upsert: true, runValidators: true },
  );
  const rosterSummary = (items: Array<{ employee: unknown; days: Array<{ date: string; shift: string }> }>) =>
    items.map((entry) => ({ employeeId: String(entry.employee), days: entry.days.map((day) => ({ date: day.date, shift: day.shift })) }));
  auditMutation(request, 'attendance.roster.saved', {
    storeId,
    before: previousRoster ? { weekStart, entries: rosterSummary(previousRoster.entries ?? []) } : null,
    after: { weekStart, entries: rosterSummary(rosterEntries) },
  });
  response.json({ message: 'Weekly roster saved successfully.' });
}
