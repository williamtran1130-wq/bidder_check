import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/middleware";
export function proxy(request: NextRequest) {
  // These handlers validate a bearer or the browser session themselves and must
  // return JSON (never a cookie-login redirect to the local publisher).
  if (request.nextUrl.pathname.startsWith("/api/mail-insights/") || request.nextUrl.pathname.startsWith("/api/reports/"))
    return NextResponse.next();
  // Cron endpoints authenticate their own server-only bearers. PWA assets
  // must also work without a session, including after the app tab closes.
  if (["/api/cron/storage-cleanup", "/api/cron/notifications", "/push-worker.js", "/manifest.webmanifest"].includes(request.nextUrl.pathname))
    return NextResponse.next();
  return updateSession(request);
}
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
