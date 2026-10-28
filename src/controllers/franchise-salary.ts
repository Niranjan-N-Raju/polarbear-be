import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Advance } from '../models/Advance.js';
import { Attendance } from '../models/Attendance.js';
import { ExtraDay } from '../models/ExtraDay.js';
import { Franchise } from '../models/Franchise.js';
import { Incentive } from '../models/Incentive.js';
import { User } from '../models/User.js';
import { collections, EntryKind, groupByEmployee, id, labels, number, serializeEntry, validateEntry } from '../services/franchise-salary.js';
import { auditMutation } from '../utils/businessLimits.js';
import { decryptUserFields } from '../utils/crypto.js';
import { datesBetween, localDateValue } from '../utils/dateUtils.js';
import { isEmployeeActiveOn } from '../utils/employeeStatus.js';
import { bodyRecord, isFranchiseAdmin, isPeriodValue, requireStore, stringQuery } from '../utils/franchiseRoute.js';
import { getCycleRange, resolveCycleSettings, roundCurrency } from '../utils/salaryCycle.js';
export async function getSalary(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const period = stringQuery(request, 'period');
  if (!period || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(period)) { response.status(400).json({ message: 'A valid salary period is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const store = await Franchise.findById(storeId).select('name salaryCycleType salaryCycleStartDay salaryCycleEndDay salaryCycleConfiguredAt').lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  const { cycleType, startDay, endDay } = resolveCycleSettings(store);
  const range = getCycleRange(period, cycleType, startDay);
  const cycleDates = datesBetween(range.from, range.to);
  const today = localDateValue();
  const [employees, attendance, incentives, extraDays, advances] = await Promise.all([
    User.find({ role: 'employee', isActive: { $ne: false }, franchises: storeId }).select('name position employmentType salary dateOfJoining isActive archivedAt').sort({ name: 1 }).lean(),
    Attendance.find({ franchise: storeId, date: { $gte: range.from, $lte: range.to } }).lean(),
    Incentive.find({ franchise: storeId, period }).lean(),
    ExtraDay.find({ franchise: storeId, period }).lean(),
    Advance.find({ franchise: storeId, period }).lean(),
  ]);
  const attendanceByEmployee = groupByEmployee(attendance);
  const incentivesByEmployee = groupByEmployee(incentives);
  const extraDaysByEmployee = groupByEmployee(extraDays);
  const advancesByEmployee = groupByEmployee(advances);
  const projections = employees.map((employee: any) => {
    const employeeId = id(employee._id);
    const records = new Map((attendanceByEmployee.get(employeeId) ?? []).map((record: any) => [record.date, record.status]));
    const eligibleDates = cycleDates.filter((date) => isEmployeeActiveOn(employee, date));
    const elapsedDates = eligibleDates.filter((date) => date <= today);
    const futureDays = eligibleDates.filter((date) => date > today).length;
    const paidDays = elapsedDates.filter((date) => records.get(date) === 'Present' || records.get(date) === 'Week Off').length;
    const absentDays = elapsedDates.filter((date) => records.get(date) === 'Absent').length;
    const weekOffDays = elapsedDates.filter((date) => records.get(date) === 'Week Off').length;
    const missingDays = elapsedDates.filter((date) => !records.has(date)).length;
    const employeeIncentives = (incentivesByEmployee.get(employeeId) ?? []).map((item: any) => ({ id: id(item._id), type: item.type, amount: number(item.amount) }));
    const employeeExtraDays = (extraDaysByEmployee.get(employeeId) ?? []).map((item: any) => ({ id: id(item._id), type: item.type, days: number(item.days) }));
    const employeeAdvances = (advancesByEmployee.get(employeeId) ?? []).map((item: any) => ({ id: id(item._id), type: item.type, amount: number(item.amount) }));
    const incentiveTotal = employeeIncentives.reduce((sum, item) => sum + item.amount, 0);
    const extraDaysTotal = employeeExtraDays.reduce((sum, item) => sum + item.days, 0);
    const advanceTotal = employeeAdvances.reduce((sum, item) => sum + item.amount, 0);
    const salary = number(employee.salary);
    return { employeeId, name: employee.name, position: employee.position ?? '', employmentType: employee.employmentType ?? '', salary, paidDays, absentDays, weekOffDays, missingDays, futureDays, eligibleDays: eligibleDates.length, incentives: employeeIncentives, incentiveTotal, extraDays: employeeExtraDays, extraDaysTotal, advances: employeeAdvances, advanceTotal, earnedSalary: roundCurrency((salary * (paidDays + extraDaysTotal)) / cycleDates.length) + incentiveTotal - advanceTotal, projectedSalary: roundCurrency((salary * (paidDays + futureDays + extraDaysTotal)) / cycleDates.length) + incentiveTotal - advanceTotal };
  });
  response.json({ store: { id: id(store._id), name: store.name }, cycle: { configured: Boolean(store.salaryCycleConfiguredAt), type: cycleType, startDay, endDay, ...range, totalDays: cycleDates.length }, projections });
}

export async function putSalary(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const body = bodyRecord(request);
  const isCalendarMonth = body.cycleType === 'calendar_month';
  if ((body.cycleType !== 'calendar_month' && body.cycleType !== 'custom') || (!isCalendarMonth && (!Number.isInteger(body.startDay) || Number(body.startDay) < 2 || Number(body.startDay) > 28))) {
    response.status(400).json({ message: 'Choose a valid cycle type and a custom start day from 2 to 28.' }); return;
  }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const startDay = isCalendarMonth ? 1 : Number(body.startDay);
  const store = await Franchise.findOneAndUpdate({ _id: storeId }, { $set: { salaryCycleType: body.cycleType, salaryCycleStartDay: startDay, salaryCycleEndDay: isCalendarMonth ? 31 : startDay - 1, salaryCycleConfiguredAt: new Date() } }, { new: false, runValidators: true }).lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  const endDay = isCalendarMonth ? 31 : startDay - 1;
  auditMutation(request, 'salary.cycle.updated', {
    storeId,
    targetId: storeId,
    before: { cycleType: store.salaryCycleType, startDay: store.salaryCycleStartDay, endDay: store.salaryCycleEndDay },
    after: { cycleType: body.cycleType, startDay, endDay },
  });
  response.json({ message: 'Salary cycle updated.', cycle: { startDay, endDay } });
}

export async function getSalarySlip(request: Request, response: Response, next: NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const employeeId = stringQuery(request, 'employeeId');
  const period = stringQuery(request, 'period');
  if (!period || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(period)) { response.status(400).json({ message: 'A valid salary period is required.' }); return; }
  if (!employeeId || !mongoose.isValidObjectId(employeeId)) { response.status(400).json({ message: 'A valid employee is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const store = await Franchise.findById(storeId).select('name address phone logo salaryCycleType salaryCycleStartDay salaryCycleEndDay').lean();
  if (!store) { response.status(404).json({ message: 'Store not found.' }); return; }
  const employee: any = await User.findOne({ _id: employeeId, role: 'employee', franchises: storeId }).select('name position employmentType salary dateOfJoining bankName bankAccountNumber bankIfsc panNumber').lean();
  if (!employee) { response.status(404).json({ message: 'Employee not found.' }); return; }
  decryptUserFields(employee);
  const { cycleType, startDay } = resolveCycleSettings(store);
  const range = getCycleRange(period, cycleType, startDay);
  const cycleDates = datesBetween(range.from, range.to);
  const today = localDateValue();
  const joiningDate = employee.dateOfJoining ? localDateValue(new Date(employee.dateOfJoining)) : range.from;
  const payableDates = cycleDates.filter((date) => date >= joiningDate);
  const elapsedDates = payableDates.filter((date) => date <= today);
  const [attendance, incentives, extraDays, advances] = await Promise.all([
    Attendance.find({ franchise: storeId, employee: employeeId, date: { $gte: range.from, $lte: range.to } }).select('date status').lean(),
    Incentive.find({ franchise: storeId, employee: employeeId, period }).select('type amount').lean(),
    ExtraDay.find({ franchise: storeId, employee: employeeId, period }).select('type days').lean(),
    Advance.find({ franchise: storeId, employee: employeeId, period }).select('type amount').lean(),
  ]);
  const attendanceByDate = new Map(attendance.map((record: any) => [record.date, record.status]));
  const presentDays = elapsedDates.filter((date) => attendanceByDate.get(date) === 'Present').length;
  const weekOffDays = elapsedDates.filter((date) => attendanceByDate.get(date) === 'Week Off').length;
  const absentDays = elapsedDates.filter((date) => attendanceByDate.get(date) === 'Absent').length;
  const paidDays = presentDays + weekOffDays;
  const extraDaysTotal = extraDays.reduce((sum: number, item: any) => sum + number(item.days), 0);
  const incentiveTotal = incentives.reduce((sum: number, item: any) => sum + number(item.amount), 0);
  const advanceTotal = advances.reduce((sum: number, item: any) => sum + number(item.amount), 0);
  const basicSalary = roundCurrency((number(employee.salary) * (paidDays + extraDaysTotal)) / cycleDates.length);
  response.json({ store: { name: store.name, address: store.address ?? '', phone: store.phone ?? '', logoUrl: store.logo?.fileId ? `/api/stores/logo?storeId=${id(storeId)}` : '' }, period, periodLabel: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(`${period}-01T00:00:00`)), employee: { name: employee.name, position: employee.position ?? '', employmentType: employee.employmentType ?? '', bankName: employee.bankName ?? '', bankAccountNumber: employee.bankAccountNumber ?? '', bankIfsc: employee.bankIfsc ?? '', panNumber: employee.panNumber ?? '' }, attendance: { totalWorkingDays: payableDates.length, presentDays, weekOffDays, absentDays, extraDays: extraDays.map((item: any) => ({ type: item.type, days: item.days })), extraDaysTotal }, earnings: { basicSalary, grossEarnings: basicSalary }, deductions: { advances, advanceTotal, totalDeductions: advanceTotal }, incentives, incentiveTotal, netPay: basicSalary + incentiveTotal - advanceTotal });
}

export async function listEntry(kind: EntryKind, request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const period = stringQuery(request, 'period');
  if (!period || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(period)) { response.status(400).json({ message: 'A valid period is required.' }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const entries = await collections[kind].find({ franchise: storeId, period }).lean();
  response.json({ [kind === 'extraDay' ? 'extraDays' : `${kind}s`]: entries.map((item: any) => serializeEntry(item, kind)) });
}
export async function createEntry(kind: EntryKind, request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const body = bodyRecord(request);
  const employeeId = typeof body.employeeId === 'string' ? body.employeeId : '';
  if (!mongoose.isValidObjectId(employeeId)) { response.status(400).json({ message: 'A valid employee is required.' }); return; }
  if (!isPeriodValue(body.period)) { response.status(400).json({ message: 'A valid period is required.' }); return; }
  const validated = validateEntry(body, kind);
  if ('error' in validated) { response.status(400).json({ message: validated.error }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const employee = await User.findOne({ _id: employeeId, role: 'employee', franchises: storeId }).select('_id').lean();
  if (!employee) { response.status(404).json({ message: 'Employee not found in this store.' }); return; }
  const entry = await collections[kind].create({ franchise: storeId, employee: employeeId, period: body.period, ...validated.value, createdBy: new mongoose.Types.ObjectId(request.auth!.id) });
  auditMutation(request, `salary.${kind}.created`, { storeId, targetId: entry._id, after: { employeeId, period: body.period, ...validated.value } });
  response.status(201).json({ message: `${labels[kind]} added successfully.`, [kind]: serializeEntry(entry, kind) });
}
export async function updateEntry(kind: EntryKind, request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const entryId = String(request.params.id);
  const idLabel = kind === "extraDay" ? "extra day" : kind;
  if (!mongoose.isValidObjectId(entryId)) { response.status(400).json({ message: "A valid " + idLabel + " id is required." }); return; }

  const validated = validateEntry(bodyRecord(request), kind);
  if ('error' in validated) { response.status(400).json({ message: validated.error }); return; }
  const updateValue = validated.value;

  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const entry = await collections[kind].findOne({ _id: entryId, franchise: storeId });
  if (!entry) { response.status(404).json({ message: kind === "extraDay" ? "Extra days entry not found." : kind === "advance" ? "Advance not found." : "Incentive not found." }); return; }

  const before = serializeEntry(entry, kind);
  Object.assign(entry, updateValue);
  await entry.save();
  auditMutation(request, `salary.${kind}.updated`, { storeId, targetId: entry._id, before, after: updateValue });
  response.json({ message: kind === "extraDay" ? "Extra days updated." : kind === "advance" ? "Advance updated." : "Incentive updated.", id: id(entry._id), ...updateValue });

}
export async function deleteEntry(kind: EntryKind, request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) {
  if (!isFranchiseAdmin(request)) { next(); return; }
  const entryId = String(request.params.id);
  if (!mongoose.isValidObjectId(entryId)) { response.status(400).json({ message: `A valid ${kind === 'extraDay' ? 'extra day' : kind} id is required.` }); return; }
  const storeId = await requireStore(request, response);
  if (!storeId) return;
  const deleted = await collections[kind].findOneAndDelete({ _id: entryId, franchise: storeId }).lean();
  if (!deleted) { response.status(404).json({ message: `${labels[kind]} not found.` }); return; }
  auditMutation(request, `salary.${kind}.deleted`, { storeId, targetId: entryId, before: serializeEntry(deleted, kind) });
  response.json({ message: `${labels[kind]} removed.` });
}