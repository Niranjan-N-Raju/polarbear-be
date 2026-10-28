import { localDateValue } from "./dateUtils.js";

export const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

export function isValidPeriod(value: string) {
  if (!PERIOD_PATTERN.test(value)) return false;
  const month = Number(value.slice(5));
  return month >= 1 && month <= 12;
}

export { localDateValue } from "./dateUtils.js";

export function dateValue(year: number, monthIndex: number, day: number) {
  // Clamp month-end dates rather than letting Date roll February's day 31 into March.
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const date = new Date(year, monthIndex, Math.min(day, lastDay));
  return localDateValue(date);
}

/** Custom periods are labeled by their ending month and begin in the prior month. */
export function getCycleRange(
  period: string,
  cycleType: "calendar_month" | "custom",
  startDay: number,
) {
  const [year, month] = period.split("-").map(Number);
  const endMonthIndex = month - 1;
  if (cycleType === "calendar_month") {
    return {
      from: dateValue(year, endMonthIndex, 1),
      to: dateValue(year, endMonthIndex, 31),
    };
  }
  return {
    from: dateValue(year, endMonthIndex - 1, startDay),
    to: dateValue(year, endMonthIndex, startDay - 1),
  };
}

export function resolveCycleSettings(store: {
  salaryCycleType?: "calendar_month" | "custom";
  salaryCycleStartDay?: number;
  salaryCycleEndDay?: number;
}) {
  // Older stores may have start/end days without an explicit cycle type.
  const cycleType =
    store.salaryCycleType ??
    (store.salaryCycleStartDay === 1 && store.salaryCycleEndDay === 31
      ? "calendar_month"
      : "custom");
  const startDay = cycleType === "calendar_month" ? 1 : (store.salaryCycleStartDay ?? 2);
  const endDay = cycleType === "calendar_month" ? 31 : startDay - 1;
  return { cycleType, startDay, endDay };
}

export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
