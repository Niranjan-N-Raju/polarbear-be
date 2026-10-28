export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const BUSINESS_TIME_ZONE = "Asia/Kolkata";

const businessDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) of an instant in the business timezone (India), independent of server TZ. */
export function businessDateValue(date: Date = new Date()): string {
  const parts = businessDateFormatter.formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** First and last date of the current business-timezone month. */
export function businessMonthRange(date: Date = new Date()): { from: string; to: string } {
  const today = businessDateValue(date);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = today.slice(0, 7);
  return { from: `${prefix}-01`, to: `${prefix}-${String(lastDay).padStart(2, "0")}` };
}

/** Adds whole days to a YYYY-MM-DD value using UTC arithmetic (no DST/timezone drift). */
export function addDaysToDateValue(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Instant at which a business date begins (midnight Asia/Kolkata, UTC+05:30, no DST). */
export function businessDayStart(value: string): Date {
  return new Date(`${value}T00:00:00+05:30`);
}

export function currentMonthRange(): { from: string; to: string } {
  return businessMonthRange();
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
  return businessDateValue(date);
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
