export interface SalaryHistorySource {
  salary?: number | null;
  salaryBaseline?: number | null;
  position?: string | null;
  salaryRevisions?: Array<{ effectiveFrom: string; salary: number; position?: string }>;
}

export function positionAtDate(employee: SalaryHistorySource, date: string): string {
  let position = employee.position ?? '';
  let effectiveFrom = '';
  for (const revision of employee.salaryRevisions ?? []) {
    if (revision.position && revision.effectiveFrom <= date && revision.effectiveFrom > effectiveFrom) {
      position = revision.position;
      effectiveFrom = revision.effectiveFrom;
    }
  }
  return position;
}

export function salaryAtDate(employee: SalaryHistorySource, date: string): number {
  let salary = employee.salaryBaseline ?? employee.salary ?? 0;
  let effectiveFrom = '';
  for (const revision of employee.salaryRevisions ?? []) {
    if (revision.effectiveFrom <= date && revision.effectiveFrom > effectiveFrom) {
      salary = revision.salary;
      effectiveFrom = revision.effectiveFrom;
    }
  }
  return salary;
}

export function salaryForDates(employee: SalaryHistorySource, paidDates: string[], extraDays: number, cycleDays: number, cycleEnd: string): number {
  return (paidDates.reduce((sum, date) => sum + salaryAtDate(employee, date), 0) + salaryAtDate(employee, cycleEnd) * extraDays) / cycleDays;
}