import { z } from "zod";
import { isCalendarDate } from "./calendar-period";

export const editableBidField = z.enum(["company", "role_name", "url", "source", "arrangement", "job_status", "resume_id"]);
export const workArrangement = z.enum(["remote", "onsite", "hybrid"]);
export const jobStatus = z.enum(["open", "closed"]);
export const importDate = z.string().refine(isCalendarDate);
// Content remains row-validated by SQL, so one bad URL/status cannot reject a reviewed subset.
export const importRows = z.array(z.object({ company: z.string(), role_name: z.string(), url: z.string(), source: z.string(), arrangement: z.string(), job_status: z.string() }).passthrough()).min(1).max(500);
