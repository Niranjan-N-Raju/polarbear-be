import { localDateValue } from "./dateUtils.js";

/**
 * Determines whether an employee was actively employed on a given date,
 * based on their join date and (if archived) their archive date.
 */
export interface EmployeeStatusFields {
  dateOfJoining?: string | Date | null;
  archivedAt?: string | Date | null;
  isActive?: boolean;
}

export function isEmployeeActiveOn(employee: EmployeeStatusFields, date: string): boolean {

  if (employee.dateOfJoining) {
    const joinDate = localDateValue(new Date(employee.dateOfJoining));
    if (joinDate > date) return false;
  }

  if (employee.isActive === false) {
    if (!employee.archivedAt) return false;
    const archivedDate = localDateValue(new Date(employee.archivedAt));
    // Active up to (and including) the day they were archived.
    if (archivedDate <= date) return false;
  }

  return true;
}
