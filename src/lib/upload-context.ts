import { isIP } from "node:net";
import type { CapturedUploadContext } from "./upload-context-types";

function geographicValue(raw: string | null, limit: number): string | null {
  if (!raw || raw.length > 1080) return null;
  try {
    const decoded = decodeURIComponent(raw);
    if (/[\p{Cc}\p{Cf}]/u.test(decoded)) return null;
    const value = decoded.trim();
    if (!value || value.length > limit) return null;
    return value;
  } catch { return null; }
}

/** Only call with server deployment trust; headers alone cannot establish trust.
 * Vercel's platform IP header avoids caller-controlled forwarding chains:
 * https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
 */
export function captureUploadContext(headers: Pick<Headers, "get">, trustedVercel: boolean): CapturedUploadContext {
  const unavailable: CapturedUploadContext = { ip: null, city: null, region: null, country: null, source: "unavailable", status: "unavailable" };
  if (!trustedVercel) return unavailable;
  const ip = headers.get("x-vercel-forwarded-for")?.trim();
  if (!ip || ip.length > 45 || ip.includes("%") || !isIP(ip)) return unavailable;
  const city = geographicValue(headers.get("x-vercel-ip-city"), 120);
  const region = geographicValue(headers.get("x-vercel-ip-country-region"), 3);
  const country = geographicValue(headers.get("x-vercel-ip-country"), 2);
  return { ip, city, region: region && /^[A-Za-z0-9]{1,3}$/.test(region) ? region.toUpperCase() : null, country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null, source: "vercel", status: "available" };
}
