import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { NotificationSchedule } from "@/lib/notification-types";
const zone = "America/Chicago";
const localFormat = "yyyy-MM-dd'T'HH:mm";
function wallTime(local: string, recurring: boolean) {
  const approximate = fromZonedTime(local, zone).getTime();
  if (!Number.isFinite(approximate))
    throw new Error("Choose a valid Central time");
  const exact = [
    approximate - 3600000,
    approximate,
    approximate + 3600000,
  ].filter((stamp) => formatInTimeZone(stamp, zone, localFormat) === local);
  if (exact.length) return Math.min(...exact);
  if (!recurring)
    throw new Error(
      "This Central Time does not exist because clocks move forward. Choose another time",
    );
  // Match SQL's forward spring-gap mapping, including date-fns-tz versions
  // that initially map the nonexistent wall-clock minute backward.
  return (
    approximate +
    Math.max(
      0,
      Date.parse(`${local}Z`) -
        Date.parse(`${formatInTimeZone(approximate, zone, localFormat)}Z`),
    )
  );
}
export function previewScheduleInstant(
  schedule: NotificationSchedule,
  now = new Date(),
) {
  if (schedule.kind === "now") return now.toISOString();
  if (schedule.kind === "once") {
    const stamp = wallTime(schedule.scheduled_local, false);
    if (stamp <= now.getTime())
      throw new Error("Choose a future send time or Send now");
    return new Date(stamp).toISOString();
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.local_time))
    throw new Error("Choose a valid Central time");
  const day = formatInTimeZone(now, zone, "yyyy-MM-dd");
  for (let offset = 0; offset <= 7; offset++) {
    const calendarDay = new Date(
      Date.parse(`${day}T12:00:00Z`) + offset * 86400000,
    );
    if (
      schedule.kind === "weekly" &&
      !schedule.weekdays.includes(calendarDay.getUTCDay())
    )
      continue;
    const stamp = wallTime(
      `${calendarDay.toISOString().slice(0, 10)}T${schedule.local_time}`,
      true,
    );
    if (stamp > now.getTime()) return new Date(stamp).toISOString();
  }
  throw new Error("Choose at least one valid weekday");
}
