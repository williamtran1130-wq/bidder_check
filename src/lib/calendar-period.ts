import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export const CALENDAR_TIMEZONE = "America/Chicago";
export const CALENDAR_PERIODS = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["this_week", "This week"],
  ["last_week", "Last week"],
  ["this_month", "This month"],
  ["last_month", "Last month"],
  ["all", "All time"],
  ["custom", "Custom range"],
] as const;
export type CalendarPeriod = (typeof CALENDAR_PERIODS)[number][0];
export type PeriodSelection = { preset: CalendarPeriod; from?: string; to?: string };
export type CalendarRange = { from?: string; to?: string };
export class PeriodValidationError extends Error {}

export function isCalendarPeriod(value: string): value is CalendarPeriod {
  return CALENDAR_PERIODS.some(([preset]) => preset === value);
}
export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function calendarToday(now = new Date()): string {
  return formatInTimeZone(now, CALENDAR_TIMEZONE, "yyyy-MM-dd");
}
export function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function resolveCalendarPeriod(selection: PeriodSelection, now = new Date()): CalendarRange {
  if (!selection || !isCalendarPeriod(selection.preset))
    throw new PeriodValidationError("Choose a valid period.");
  const today = calendarToday(now);
  switch (selection.preset) {
    case "all": return {};
    case "today": return { from: today, to: today };
    case "yesterday": {
      const yesterday = shiftCalendarDate(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "this_week":
    case "last_week": {
      const daysSinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      const monday = shiftCalendarDate(today, -daysSinceMonday);
      return selection.preset === "this_week"
        ? { from: monday, to: today }
        : { from: shiftCalendarDate(monday, -7), to: shiftCalendarDate(monday, -1) };
    }
    case "this_month": return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last_month": {
      const last = shiftCalendarDate(`${today.slice(0, 7)}-01`, -1);
      return { from: `${last.slice(0, 7)}-01`, to: last };
    }
    case "custom": {
      const { from, to } = selection;
      if (!from || !to || !isCalendarDate(from) || !isCalendarDate(to) || from > to)
        throw new PeriodValidationError("Choose a valid start and end date.");
      return { from, to };
    }
  }
}
export function periodTimestampBounds(range: CalendarRange): CalendarRange {
  if (!range.from && !range.to) return {};
  if (!range.from || !range.to || !isCalendarDate(range.from) || !isCalendarDate(range.to) || range.from > range.to)
    throw new PeriodValidationError("Choose a valid start and end date.");
  return {
    from: fromZonedTime(`${range.from}T00:00:00`, CALENDAR_TIMEZONE).toISOString(),
    to: fromZonedTime(`${shiftCalendarDate(range.to, 1)}T00:00:00`, CALENDAR_TIMEZONE).toISOString(),
  };
}
