import { isCalendarDate } from "./calendar-period";

export function applicationRate(found: number, foundApplied: number) {
  return found === 0 ? null : (foundApplied / found) * 100;
}

export function dashboardDateLabel(date: string) {
  if (!isCalendarDate(date)) throw new Error("Invalid report date.");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}
