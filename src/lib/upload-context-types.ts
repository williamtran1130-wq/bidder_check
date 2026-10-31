/** Latest successful screenshot application location, captured only on the server. */
export type ApplicationLocation = {
  ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  uploadedAt: string;
  source: "vercel" | "unavailable";
  status: "available" | "unavailable";
};
export type CapturedUploadContext = Omit<ApplicationLocation, "uploadedAt">;
