import { z } from "zod";

/** Only explicit application messages may cross a server-action boundary. */
export class ActionValidationError extends Error {}
const publicMessages = new Set([
  "Access denied", "Manager access denied", "Blocked", "Assignment unavailable",
  "A correction reason is required", "A rejection reason is required", "A reason is required (up to 1000 characters)",
  "A bid was selected more than once", "A request id is required", "A selected bid changed. Refresh and review the current rows.",
  "A selected bid changed. Refresh and select it again", "A selected bid changed. Refresh and try again",
  "A selected bid is no longer in this view", "A selected bid is unavailable", "A value is required",
  "Access denied to current screenshot", "Account reservation is missing or already used", "An assignment with bid history cannot be moved",
  "Application library is temporarily paused for a verified data reset", "Applied bid details can only be corrected by a client or admin",
  "Applied time cannot be earlier than a bid’s Found time", "Applied time cannot be in the future", "Ask your client to configure a bid rate first",
  "Assignment email and phone are required", "Assignment not found", "Assignment profile not found", "Bid not found", "Bidder not found",
  "Candidate profile not found", "Cannot change this resume assignment", "Choose a file up to 10 MB", "Choose a future send time or Send now",
  "Choose a send time", "Choose a valid Added date that is not in the future", "Choose a valid Central time", "Choose a valid Central Time send date",
  "Choose a valid date range", "Choose a verified PDF assigned to this bidder",
  "Choose an active bidder", "Choose an active bidder in this workspace", "Choose an active profile", "Choose an active resume assigned to this bidder",
  "Choose approved or rejected", "Choose at least one valid weekday", "Choose at least one weekday", "Choose open or closed", "Choose remote, onsite or hybrid",
  "Choose valid recipients and schedule", "Choose valid weekdays", "Choose valid work and job statuses", "Client not found", "Company and role are required",
  "Client approval changed. Request approval before uploading new proof", "Client approval is required before uploading a screenshot",
  "Company limit or retention period is invalid", "Configure a rate before manually applying every selected bid",
  "Confirmation expired. Prepare a new confirmation", "Duplicate bid selected", "Duplicate targets", "Email is reserved for another account",
  "Enter a valid client name and email", "Every selected bidder must be active in this workspace", "Field is not editable", "File not found", "Immutable file",
  "Import 1 to 500 mapped rows", "Import 1 to 500 rows within the payload limit", "Import request ID required", "Import source row numbers are invalid",
  "Interview notes can contain at most 2000 characters", "Invalid approval status", "Invalid deletion scope", "Invalid history cursor", "Invalid message status",
  "Invalid timezone", "Invalid URL", "Invalid URL port", "Maximum 200 characters", "Name required", "No eligible bids in trash",
  "Notification not found", "Notification not found or resolved", "One or more selected bids are inaccessible", "Only a draft or active schedule can be edited",
  "Only active clients and admins can manually apply bids", "Only active, unapplied bids can be reviewed", "Only an active rejected bid can be resubmitted",
  "Only applied bids can have an interview invitation", "Only new messages and drafts can be saved as drafts", "Profile ID and candidate name are required",
  "Profile not found or archived", "Rate is invalid", "Reapplication cannot precede the first application time", "Record not found", "Required; maximum 200 characters",
  "Restoration blocked", "Restore selected bids from trash before applying", "Restore this bid before changing interview status",
  "Restore this bid from trash before correcting", "Restore this bid from trash before editing", "Restore this bid from trash before uploading",
  "Restriction values must contain 1 to 200 characters", "Resume assignments accept PDF files only", "Resume is archived", "Resume is locked after first application",
  "Resume not found or archived", "Resume or bidder archived", "Resume PDF must be verified for this bidder assignment", "Resume, profile or bidder archived",
  "Rows must be an array", "Select 1 to 500 bids", "Select between 1 and 500 bids", "Select bids to apply", "Selected bids changed. Refresh and try again",
  "Sign in to apply bids", "The shared candidate profile is unavailable", "This Central Time does not exist because clocks move forward. Choose another time",
  "This email already has a managed account", "This email already has an account", "This email is already in use or reserved", "This email is already invited",
  "This email is reserved for a managed account", "This request id was already used for different content", "This request ID was already used with different content",
  "This URL already exists for this resume", "This URL is in trash; restore the matching bid", "Title and message are required", "Trash changed. Prepare a new confirmation",
  "Trash state required", "Unsupported file kind", "Unsupported resume type", "Unsupported screenshot type", "Upload a screenshot to apply automatically",
  "Upload a valid screenshot first", "Upload and verify a PDF resume before adding bids", "Upload and verify a PDF resume before importing bids",
  "Upload context is immutable", "Upload new proof; this screenshot was previously rejected", "URL is too long", "Use a canonical IPv4 address",
  "Use an ASCII or encoded domain name", "Valid HTTP(S) job URL required", "Valid name and email required", "Workspace is inactive", "Workspace not found",
  "The shared candidate profile is unavailable.", "This profile is archived and cannot receive new bids.", "Company name matches a restricted company rule.",
  "Role title matches a restricted role rule.", "Job link matches a restricted link rule.", "This profile has the matching job in trash; restore the existing bid.",
  "This profile already has an application for this job.", "The company limit for bids on this profile has been reached.",
  "This bid changed. Refresh the current row before reviewing it.", "This bid changed. Refresh the current row before resubmitting it.",
  "Only clients and admins can manually apply bids", "Confirm the password reset first", "Account type does not match", "Account reservation failed. Please retry.",
  "File not found.", "Only the uploader can finalize this file.", "Upload has not completed. Please retry.", "File size does not match the upload.",
  "The file contents do not match its type.", "File is unavailable.", "Type DELETE to confirm.", "Import payload is too large", "Import row mapping is invalid",
  "Enter a valid HTTP or HTTPS job URL.", "Use a positive USD amount with up to two decimals.", "Rate is too large.", "This file type is not supported.",
  "Choose a file between 1 byte and 10 MB.", "The screenshot is invalid or damaged. Choose a valid PNG, JPEG or WebP image.",
]);

export function actionErrorMessage(error: unknown, fallback = "This request could not be completed. Please retry."): string {
  if (error instanceof ActionValidationError) return error.message;
  if (error instanceof z.ZodError) return "Check the fields and choose valid values.";
  const value = error && typeof error === "object" ? error as { message?: unknown; code?: unknown } : undefined;
  if (value?.code === "23505") return "This record already exists. Check the resume identifier or job URL.";
  if (value?.code === "42501") return "Access denied";
  if (typeof value?.message === "string" && (publicMessages.has(value.message) || /^Retention change affects \d+ applied bids\. Review the count and confirm again\.$/.test(value.message))) return value.message;
  return fallback;
}
