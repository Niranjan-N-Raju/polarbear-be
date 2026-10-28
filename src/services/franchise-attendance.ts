import { type AttendanceRecord } from '../models/Attendance.js';
import { datesBetween, isValidDate, localDateValue } from '../utils/dateUtils.js';
export const STATUSES = new Set<AttendanceRecord['status']>(['Present', 'Week Off', 'Absent']);
export const MAX_ENTRIES = 500;
export type Shift = { id: string; name: string; startTime: string; endTime: string; };
export type RosterDay = { date: string; shift?: string; status?: string; startTime?: string; endTime?: string; };
export function validMonday(value: string) {
  return isValidDate(value) && new Date(`${value}T00:00:00`).getDay() === 1;
}
export function mondayOnOrBefore(value: string) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDateValue(date);
}
export function weekDates(weekStart: string) {
  const end = new Date(`${weekStart}T00:00:00`);
  end.setDate(end.getDate() + 6);
  return datesBetween(weekStart, localDateValue(end));
}
export function resolveShift(day: RosterDay, shifts: Shift[]) {
  if (day.shift === 'off' || day.status === 'off') return 'off';
  const exact = shifts.find((shift) => shift.id === day.shift);
  if (exact) return exact.id;
  const byTime = shifts.find((shift) => shift.startTime === day.startTime && shift.endTime === day.endTime);
  if (byTime) return byTime.id;
  // Older rosters stored morning/night labels instead of configurable shift IDs.
  const label = day.shift?.toLowerCase();
  const legacyTimes = label === 'night' ? ['17:00', '02:00'] : label === 'morning' ? ['09:00', '18:00'] : null;
  return legacyTimes ? shifts.find((shift) => shift.startTime === legacyTimes[0] && shift.endTime === legacyTimes[1])?.id ?? 'off' : 'off';
}
export function serializeRoster(roster: { weekStart: string; entries: Array<{ employee: unknown; days: RosterDay[]; }>; }, shifts: Shift[]) {
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
