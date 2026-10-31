import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { getContext, type getActor } from "./auth";
import { AuthorizationError } from "./authorization-error";
import {
  PeriodValidationError,
  resolveCalendarPeriod,
} from "./calendar-period";
import type {
  GroupedReportQuery,
  ReportQuery,
  ReportResult,
} from "./report-types";

type ReportOperation =
  | "dashboard_performance_v2"
  | "earnings_performance_v2"
  | "interview_performance";
/** The handler chooses typed auth failures; legacy actions and RSCs redirect. */
export function createReportReader(
  getReadContext: typeof getActor = () => getContext({ actorOnly: true }),
) {
  async function readReport<T>(
    operation: ReportOperation,
    input: ReportQuery | GroupedReportQuery,
  ): Promise<ReportResult<T>> {
    const started = performance.now();
    let errorCode = "unknown";
    let period = "invalid";
    let filterShape = { workspace: false, bidder: false, profile: false };
    try {
      const range = resolveCalendarPeriod(input.period);
      period = input.period.preset;
      filterShape = {
        workspace: !!input.workspace,
        bidder: !!input.bidder,
        profile: !!input.profile,
      };
      const filters = {
        p_workspace: input.workspace ? z.uuid().parse(input.workspace) : null,
        p_bidder: input.bidder ? z.uuid().parse(input.bidder) : null,
        p_profile: input.profile ? z.uuid().parse(input.profile) : null,
      };
      const grouping =
        "group" in input
          ? z.enum(["profile", "bidder", "assignment"]).parse(input.group)
          : undefined;
      const { supabase, profile } = await getReadContext();
      if (operation === "earnings_performance_v2" && profile.role === "bidder")
        return {
          error: "This report is available to workspace managers.",
          code: "forbidden",
        };
      const args = {
        p_from: range.from ?? null,
        p_to: range.to ?? null,
        ...filters,
        ...(grouping ? { p_group: grouping } : {}),
      };
      const { data, error } = input.email && operation === "dashboard_performance_v2"
        ? await supabase.rpc("dashboard_email_performance", { ...args, p_email: z.email().max(320).parse(input.email).trim().toLowerCase() })
        : await supabase.rpc(operation, args);
      if (error) {
        errorCode = error.code || "unknown";
        throw new Error("Report request failed");
      }
      if (!data || typeof data !== "object") {
        errorCode = "invalid_response";
        throw new Error("Incomplete report response");
      }
      console.info("Report query", {
        operation,
        period,
        filterShape,
        group: grouping,
        durationMs: Math.round(performance.now() - started),
        outcome: "success",
      });
      return { data: data as unknown as T };
    } catch (error) {
      unstable_rethrow(error);
      if (error instanceof AuthorizationError) throw error;
      if (error instanceof PeriodValidationError || error instanceof z.ZodError)
        return {
          error: "Choose a valid period and report filters.",
          code: "validation",
        };
      console.info("Report query", {
        operation,
        period,
        filterShape,
        durationMs: Math.round(performance.now() - started),
        outcome: "failed",
        errorCode,
      });
      if (errorCode === "42501")
        return {
          error: "You do not have access to this report.",
          code: "forbidden",
        };
      const transient =
        errorCode === "unknown" ||
        /^(57014|53300|57P0[123]|40P01|40001|55P03|08[A-Z0-9]{3}|PGRST00[012])$/.test(
          errorCode,
        );
      return {
        error: "This report is temporarily unavailable. Please retry.",
        code: transient ? "temporarily_unavailable" : "unavailable",
      };
    }
  }
  return readReport;
}
export const readReport = createReportReader();
