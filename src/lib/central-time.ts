import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { CALENDAR_TIMEZONE, isCalendarDate } from "./calendar-period";
import { ActionValidationError } from "./action-errors";

/** Minute wall-time input: reject normalization and DST gaps, choose the first fold. */
export function centralWallTimeToISO(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value) || !isCalendarDate(value.slice(0, 10)))
    throw new ActionValidationError("Choose a valid date and time in Central Time.");
  const instant = fromZonedTime(value, CALENDAR_TIMEZONE);
  if (!Number.isFinite(instant.getTime()) || formatInTimeZone(instant, CALENDAR_TIMEZONE, "yyyy-MM-dd'T'HH:mm") !== value)
    throw new ActionValidationError("This Central Time does not exist because clocks move forward. Choose another time");
  const earlier = new Date(instant.getTime() - 60 * 60 * 1000);
  return (formatInTimeZone(earlier, CALENDAR_TIMEZONE, "yyyy-MM-dd'T'HH:mm") === value ? earlier : instant).toISOString();
}
