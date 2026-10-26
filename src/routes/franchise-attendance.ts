import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { Attendance, type AttendanceRecord } from '../models/Attendance.js';
import { Franchise } from '../models/Franchise.js';
import { User } from '../models/User.js';
import { WeeklyRoster } from '../models/WeeklyRoster.js';
import { datesBetween, exceedsMaxRange, isValidDate, localDateValue, MAX_RANGE_DAYS } from '../utils/dateUtils.js';
import { isEmployeeActiveOn } from '../utils/employeeStatus.js';
import { bodyRecord, isFranchiseAdmin, requireStore, stringQuery } from '../utils/franchiseRoute.js';
import { isDateValue } from '../utils/storeAccess.js';

export const franchiseAttendanceRouter = Router();
const router = franchiseAttendanceRouter;
const STATUSES = new Set<AttendanceRecord['status']>(['Present', 'Week Off', 'Absent']);
const MAX_ENTRIES = 500;

type Shift = { id: string; name: string; startTime: string; endTime: string };
type RosterDay = { date: string; shift?: string; status?: string; startTime?: string; endTime?: string };

function validMonday(value: string) {
  return isValidDate(value) && new Date(`${value}T00:00:00`).getDay() === 1;
}

function mondayOnOrBefore(value: string) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDateValue(date);
}

function weekDates(weekStart: string) {
  const end = new Date(`${weekStart}T00:00:00`);
  end.setDate(end.getDate() + 6);
  return datesBetween(weekStart, localDateValue(end));
}

function resolveShift(day: RosterDay, shifts: Shift[]) {
  if (day.shift === 'off' || day.status === 'off') return 'off';
  const exact = shifts.find((shift) => shift.id === day.shift);
  if (exact) return exact.id;
  const byTime = shifts.find((shift) => shift.startTime === day.startTime && shift.endTime === day.endTime);
  if (byTime) return byTime.id;
  const label = day.shift?.toLowerCase();
  const legacyTimes = label === 'night' ? ['17:00', '02:00'] : label === 'morning' ? ['09:00', '18:00'] : null;
  return legacyTimes ? shifts.find((shift) => shift.startTime === legacyTimes[0] && shift.endTime === legacyTimes[1])?.id ?? 'off' : 'off';
}

function serializeRoster(roster: { weekStart: string; entries: Array<{ employee: unknown; days: RosterDay[] }> }, shifts: Shift[]) {
  return {
    weekStart: roster.weekStart,
    entries: roster.entries.map((entry) => ({
      employeeId: String(entry.employee),
      days: entry.days.map((day) => {
        const shift = resolveShift(day, shifts);
        const shiftConfig = shifts.find((item) => item.id === shift);
        return {
          date: day.date,
          shift,
          shiftName: shiftConfig?.name ?? (shift === 'off' ? 'Off' : 'Unconfigured shift'),
          startTime: shiftConfig?.startTime ?? '',
          endTime: shiftConfig?.endTime ?? '',
        };
      }),
    })),
  };
}

router.get('/attendance', requireAuth, async (request, response, next) => {
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

  if (hasRange) {
    const rosters = await WeeklyRoster.find({ franchise: storeId, 'entries.days.date': { $gte: from, $lte: to } }).lean();
    const defaults = rosters.flatMap((roster) => roster.entries.flatMap((entry) => entry.days
      .filter((day) => day.date >= from! && day.date <= to!)
      .map((day) => ({
        updateOne: {
          filter: { franchise: storeId, employee: entry.employee, date: day.date },
          update: { $setOnInsert: {
            franchise: storeId,
            employee: entry.employee,
            date: day.date,
            status: (day.shift === 'off' ? 'Week Off' : 'Present') as AttendanceRecord['status'],
            comment: '',
            createdBy: roster.createdBy,
          } },
          upsert: true,
        },
      }))));
    if (defaults.length) await Attendance.bulkWrite(defaults);
  }

  const records = await Attendance.find({ franchise: storeId, ...(hasDate ? { date } : { date: { $gte: from, $lte: to } }) }).lean();
  response.json({ records: records.map((record) => ({ employeeId: String(record.employee), date: record.date, status: record.status as AttendanceRecord['status'], comment: record.comment ?? '' })) });
});

router.put('/attendance', requireAuth, async (request, response, next) => {
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
  const operations = savedRecords.map((record) => ({
    updateOne: {
      filter: { franchise: storeId, employee: new mongoose.Types.ObjectId(record.employeeId as string), date },
      update: { $set: { status: record.status as AttendanceRecord['status'], comment: typeof record.comment === 'string' ? record.comment.trim() : '', createdBy: actor } },
      upsert: true,
    },
  }));
  if (operations.length) await Attendance.bulkWrite(operations);
  response.json({ message: skippedCount ? `Attendance saved for ${savedRecords.length} employee(s). ${skippedCount} employee(s) weren't active on this date and were skipped.` : 'Attendance saved successfully.', skippedCount });
});

router.delete('/attendance', requireAuth, async (request, response, next) => {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const date = stringQuery(request, 'date');
  const employeeId = stringQuery(request, 'employeeId');
  if (!isDateValue(date) || !employeeId || !mongoose.isValidObjectId(employeeId)) { response.status(400).json({ message: 'A valid store, date, and employee are required.' }); return; }
  const deleted = await Attendance.findOneAndDelete({ franchise: storeId, employee: employeeId, date }).lean();
  if (!deleted) { response.status(404).json({ message: 'Attendance record not found.' }); return; }
  response.json({ message: 'Attendance record removed.' });
});

router.get('/attendance/weekly-roster', requireAuth, async (request, response, next) => {
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
});

router.put('/attendance/weekly-roster', requireAuth, async (request, response, next) => {
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
  await WeeklyRoster.findOneAndUpdate(
    { franchise: storeId, weekStart },
    { $set: { entries: rosterEntries }, $setOnInsert: { createdBy: new mongoose.Types.ObjectId(request.auth!.id) } },
    { new: true, upsert: true, runValidators: true },
  );
  response.json({ message: 'Weekly roster saved successfully.' });
});
