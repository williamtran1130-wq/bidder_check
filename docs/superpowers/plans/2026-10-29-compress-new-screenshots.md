# Compress New Screenshot Uploads Implementation Plan

User-approved plan, 2026-10-29. Local implementation only; production migration,
deployment and activation each require the approval gates described below.

**Goal:** reduce retained screenshot bytes and subsequent preview egress without
changing original-proof identity or size matching. Existing images expire under
the current seven-day policy; no backfill.

**Architecture:** validate and hash original caller-authorized bytes, encode with
existing Sharp, reserve a private candidate with durable cleanup, upload without
overwrite, and atomically finalize the retained representation. Original upload
metadata remains authoritative for proof review. Server flag defaults off.

## Constraints

- New screenshots only; resumes and existing objects are unchanged.
- WebP quality 90, alpha quality 100, effort 4; preserve displayed orientation
  and dimensions, strip unnecessary metadata, retain only a smaller output.
- Invalid images still fail validation. Encoding failure or no savings uses the
  valid original. Original verification still downloads once from Supabase.
- Keep `files.size_bytes`, `mime`, `filename`, `sha256` as original metadata.
  Nullable retained fields describe compressed content; `storage_path` identifies
  the retained artifact. File URL names/MIME describe the served representation.
- Service-only reservation and activation; original proof hash, current uploader
  permissions, review revision, bid-first file lock order, upload context and
  seven-day retention semantics survive compression.
- Each candidate is unique, recorded before upload, cleaned after ten minutes if
  abandoned, and cannot activate once cleanup has ever been claimed. Activation
  and cleanup cancellation share a transaction. Superseded originals use existing
  bounded cleanup and its delayed five-minute verification pass.
- Failures never overwrite a finalized artifact or remove an uncertain committed
  candidate. Concurrent activation is idempotent and losers remain cleanable.
- Aggregate metrics only; no image contents, identities, paths or signed URLs.

## Tasks

- [x] Database: forward migration, service-only reservation/finalization, retained
  metadata validation and immutability; real PGlite schema/RLS regression tests.
- [x] Encoder: production helper, focused decoding/size/orientation/alpha/fallback
  tests and reproducible local synthetic readability comparisons.
- [x] Integration: server flag, finalization orchestration, retained MIME/filename
  reads, generated types and inventory checks, failure/retry tests.
- [x] Verification: complete unit/database suite, generated types, lint, typecheck,
  desktop/mobile upload/preview tests, production build and independent review.

## Review Focus

Rejected-original reuploads; cleanup claimed before activation; deletion and
revocation racing activation; losing concurrent candidates and lost responses;
retained-object MIME/byte inventory while original-size matching stays unchanged.

## Approval and rollout

1. Complete local implementation, evidence, samples and review.
2. Obtain approval before production migration or deployment; deploy additive
   schema then compatible application with compression disabled.
3. Obtain readability and activation approval, enable compression, run isolated
   synthetic verification and remove its fixtures.
4. Monitor actual bytes, cleanup failures, latency and daily egress for seven days;
   distinguish live inventory from billing-period averages. Disable flag to stop
   future compression without breaking retained compressed files.

No quality change, existing-image recompression, shorter retention, longer caching,
paid upgrade or upload architecture redesign is included.
