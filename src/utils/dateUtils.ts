export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const to = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

// Build from local calendar fields instead of toISOString(), which can shift
// local midnight to the previous or next UTC date.
export function localDateValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateValueFromDate(value: string | Date): string {
  if (typeof value === "string" && DATE_PATTERN.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  return localDateValue(date);
}

export function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime()) && localDateValue(parsed) === value;
}

export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (current <= end) {
    dates.push(localDateValue(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}
export const MAX_RANGE_DAYS = 366;

// Expects YYYY-MM-DD values; caps query spans so range-driven loops and DB scans stay bounded.
export function exceedsMaxRange(from: string, to: string, maxDays = MAX_RANGE_DAYS): boolean {
  return Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > maxDays * 24 * 60 * 60 * 1000;
}
