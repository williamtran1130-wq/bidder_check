import { handleRead } from "@/lib/read-handler";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ operation: string }> },
) {
  return handleRead(request, (await context.params).operation);
}
/** Read-only envelope for filters that cannot safely fit in a GET URL. */
export async function POST(
  request: Request,
  context: { params: Promise<{ operation: string }> },
) {
  return handleRead(request, (await context.params).operation);
}
function unsupported() {
  return Response.json(
    { error: "Only GET and read-only POST are supported." },
    {
      status: 405,
      headers: {
        "Cache-Control": "private, no-store",
        Vary: "Cookie",
        Allow: "GET, HEAD, POST",
      },
    },
  );
}
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
export const OPTIONS = unsupported;
