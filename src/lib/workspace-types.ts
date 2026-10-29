import type { Row } from "./database.types";
export type BidderRow = Omit<Row<"bidders">, "default_rate_cents"> & {
  default_rate_cents?: number | null;
};
export const SAFE_BIDDER_COLUMNS = "user_id,workspace_id,archived" as const;
export type ResumeRow = Omit<Row<"resumes">, "rate_override_cents"> & {
  rate_override_cents?: number | null;
};
export const SAFE_RESUME_COLUMNS =
  "id,workspace_id,bidder_id,identifier,candidate_name,email,phone,address,links,instructions,file_id,archived,created_at,profile_id" as const;
export type BidRow = Omit<Row<"bids">, "rate_cents" | "screenshot_uploaded_at" | "screenshot_sha256"> & {
  rate_cents?: number | null;
  screenshot_uploaded_at?: string | null;
  screenshot_size_bytes?: number | null;
  screenshot_size_match_count?: number;
};
export const SAFE_BID_COLUMNS =
  "id,workspace_id,bidder_id,resume_id,company,role_name,url,normalized_url,source,arrangement,job_status,applied,found_at,applied_at,first_applied_at,evidence_file_id,rejected_hashes,version,created_at,deleted_at,deleted_by,review_status,review_revision,reviewed_by,reviewed_at,review_reason,interview_scheduled,interview_at,interview_notes,interview_updated_by,interview_updated_at,interview_tracking,application_method,screenshot_uploaded_at" as const;
