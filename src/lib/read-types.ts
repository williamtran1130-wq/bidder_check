export type FileUrlData = {
  url: string;
  name: string;
  mime: string;
  expiresAt: string;
};
export type FileUrlOutcome = { id: string; data?: FileUrlData; error?: string };
export type ReadFailure = {
  error: string;
  destination?: "/auth/login" | "/auth/approval" | "/auth/inactive";
};
