import { businessDateValue } from "./dateUtils.js";

/**
 * Determines whether an employee was actively employed on a given business date (Asia/Kolkata),
 * based on their join date and (if archived) their archive date.
 */
export interface EmployeeStatusFields {
  dateOfJoining?: string | Date | null;
  archivedAt?: string | Date | null;
  isActive?: boolean;
}

export function isEmployeeActiveOn(employee: EmployeeStatusFields, date: string): boolean {

  if (employee.dateOfJoining) {
    const joinDate = businessDateValue(new Date(employee.dateOfJoining));
    if (joinDate > date) return false;
  }

  if (employee.isActive === false) {
    if (!employee.archivedAt) return false;
    const archivedDate = businessDateValue(new Date(employee.archivedAt));
    // archivedAt marks the first inactive instant: the employee is active only on dates strictly
    // before archivedAt's business date. Archiving stores the start of the day after the last
    // working day, so that last day itself remains active and paid.
    if (archivedDate <= date) return false;
  }

  return true;
}
