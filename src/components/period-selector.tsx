"use client";
import { useEffect, useState } from "react";
import { fromZonedTime } from "date-fns-tz";
import { CALENDAR_PERIODS, CALENDAR_TIMEZONE, calendarToday, shiftCalendarDate, resolveCalendarPeriod, type PeriodSelection } from "@/lib/calendar-period";
import { Button } from "./ui/button";

/** Relative dates roll over at CT midnight, including after a suspended tab resumes. */
export function useCalendarDay() {
  const [day, setDay] = useState(() => calendarToday());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const now = new Date();
      const today = calendarToday(now);
      setDay(today);
      const next = fromZonedTime(`${shiftCalendarDate(today, 1)}T00:00:00`, CALENDAR_TIMEZONE);
      timer = setTimeout(update, Math.max(1, next.getTime() - now.getTime()));
    };
    update();
    window.addEventListener("focus", update);
    return () => { clearTimeout(timer); window.removeEventListener("focus", update); };
  }, []);
  return day;
}

export function PeriodSelector({ value, onChange, label = "Period" }: {
  value: PeriodSelection;
  onChange: (value: PeriodSelection) => void;
  label?: string;
}) {
  const [custom, setCustom] = useState(value.preset === "custom");
  const [from, setFrom] = useState(value.from ?? calendarToday());
  const [to, setTo] = useState(value.to ?? calendarToday());
  let valid = true;
  try { resolveCalendarPeriod({ preset: "custom", from, to }); } catch { valid = false; }
  return <div className="flex flex-wrap items-end gap-3">
    <label className="space-y-1 text-xs text-muted-foreground"><span>{label}</span>
      <select aria-label={label} className="native-select block min-w-36 text-foreground" value={custom ? "custom" : value.preset} onChange={(event) => {
        const preset = event.target.value as PeriodSelection["preset"];
        setCustom(preset === "custom");
        if (preset !== "custom") onChange({ preset });
      }}>{CALENDAR_PERIODS.map(([preset, text]) => <option key={preset} value={preset}>{text}</option>)}</select>
    </label>
    {custom && <>
      <label className="space-y-1 text-xs text-muted-foreground"><span>From (CT)</span><input aria-label={`${label} from CT`} className="native-select block text-foreground" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label className="space-y-1 text-xs text-muted-foreground"><span>Through (CT)</span><input aria-label={`${label} through CT`} className="native-select block text-foreground" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
      <Button size="sm" variant="outline" disabled={!valid} onClick={() => onChange({ preset: "custom", from, to })}>Apply range</Button>
      {!valid && <span className="text-xs text-muted-foreground" role="status">Choose a valid start and end date.</span>}
    </>}
  </div>;
}
