import "server-only";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { getActor } from "./auth";
import { createReadServices } from "./read-services";
import { createNotificationReads } from "./notification-reads";
import { createReportReader } from "./reporting-server";
const bidInput = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.boolean(),
  z.string().nullish(),
  z.object({
    search: z.string(),
    status: z.string(),
    arrangement: z.string(),
    resume: z.string(),
    bidder: z.string(),
    source: z.string(),
    job: z.string(),
    columnFilters: z.array(z.object({ id: z.string(), value: z.unknown() })),
    sorting: z.array(z.object({ id: z.string(), desc: z.boolean() })),
    pageIndex: z.number(),
    pageSize: z.number(),
  }),
]);
const period = z.object({
  preset: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
});
// Report service performs its calendar and filter validation, including structured errors.
const reportInput = z.object({
  period,
  workspace: z.string().optional(),
  bidder: z.string().optional(),
  profile: z.string().optional(),
  group: z.string().optional(),
});
const operations = new Set([
  "bids",
  "history",
  "files",
  "upload-contexts",
  "purge",
  "purges",
  "dashboard",
  "earnings",
  "interviews",
  "notification-page",
  "notification",
  "unread",
  "device",
  "legacy-inbox",
  "legacy-unread",
  "messages",
]);
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
export async function handleRead(
  request: Request,
  operation: string,
): Promise<Response> {
  // The first service boundary checks live authorization after input parsing.
  // Share that one actor/client (including a rejection) only within this request.
  let context: ReturnType<typeof getActor> | undefined;
  const requestContext = () => (context ??= getActor());
  const reads = createReadServices(requestContext);
  const notifications = createNotificationReads(requestContext);
  const readReport = createReportReader(requestContext);
  async function dispatch(): Promise<Response> {
    if (!operations.has(operation))
      return json({ error: "Unknown read operation." }, 404);
    let input: unknown;
    try {
      input =
        request.method === "POST"
          ? await request.json()
          : JSON.parse(new URL(request.url).searchParams.get("q") ?? "null");
    } catch {
      return json({ error: "Invalid read request." }, 400);
    }
    let result: unknown;
    switch (operation) {
      case "bids": {
        const [mode, from, to, trash, bidder, query] = bidInput.parse(input);
        result = await reads.getBidRows(
          mode,
          from,
          to,
          trash,
          bidder ?? undefined,
          query,
        );
        break;
      }
      case "history":
        result = await reads.getBidHistory(z.string().parse(input));
        break;
      case "files":
        result = await reads.getFileUrls(
          z.array(z.string()).max(100).parse(input),
        );
        break;
      case "upload-contexts":
        result = await reads.getScreenshotUploadContexts(
          z.array(z.uuid()).max(100).parse(input),
        );
        break;
      case "purge":
        result = await reads.getPurgeStatus(z.string().parse(input));
        break;
      case "purges":
        result = await reads.recentBidPurges();
        break;
      case "dashboard":
      case "earnings":
      case "interviews": {
        const query = reportInput.parse(input);
        const operationName =
          operation === "dashboard"
            ? "dashboard_performance_v2"
            : operation === "earnings"
              ? "earnings_performance_v2"
              : "interview_performance";
        // The report service owns validation and produces its established error codes.
        result = await readReport(
          operationName,
          query as Parameters<typeof readReport>[1],
        );
        break;
      }
      case "notification-page":
        result = await notifications.getNotificationPage(
          z
            .object({
              kind: z.enum(["inbox", "messages"]),
              workspace_id: z.string().optional(),
              status: z.string().optional(),
              cursor: z
                .object({ created_at: z.string(), id: z.string() })
                .nullish(),
            })
            .parse(input),
        );
        break;
      case "notification":
        result = await notifications.getNotificationById(
          z.string().parse(input),
        );
        break;
      case "unread":
        result = await notifications.getNotificationUnreadCount();
        break;
      case "device":
        result = await notifications.getNotificationDeviceEnabled(
          z.string().parse(input),
        );
        break;
      case "legacy-inbox":
        result = await reads.getInboxNotifications();
        break;
      case "legacy-unread":
        result = await reads.getUnreadNotificationCount();
        break;
      case "messages":
        result = await reads.getClientMessages();
        break;
    }
    return json(result);
  }
  try {
    const response = await dispatch();
    // Validation and unknown operations can return without reaching a service.
    // They still require authorization before any response leaves this handler.
    await requestContext();
    return response;
  } catch (error) {
    unstable_rethrow(error);
    try {
      await requestContext();
    } catch (authorizationError) {
      unstable_rethrow(authorizationError);
      error = authorizationError;
    }
    const destination =
      error && typeof error === "object" && "destination" in error
        ? error.destination
        : undefined;
    if (
      destination === "/auth/login" ||
      destination === "/auth/approval" ||
      destination === "/auth/inactive"
    )
      return json(
        {
          error: "Your access has changed. Please sign in again.",
          destination,
        },
        destination === "/auth/login" ? 401 : 403,
      );
    if (error instanceof z.ZodError)
      return json({ error: "Invalid read request.", code: "validation" }, 400);
    return json(
      { error: "This request could not be completed. Please retry." },
      500,
    );
  }
}
