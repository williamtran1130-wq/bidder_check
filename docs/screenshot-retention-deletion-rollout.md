# Seven-day screenshots and permanent deletion

This release uses production only. It supersedes staging-first instructions in older deployment records for this feature. No existing migration is rewritten and no global reset is performed.

## Behavior

- Screenshots expire 168 hours after successful verification. Application dates, status, rate, interviews and reports remain unchanged. A current timestamp/hash snapshot on the active bid preserves rejected-proof protection after the image is deleted.
- Bidders see status only. Managers open screenshots explicitly. The server authorizes the caller-scoped file and caps its signed URL at the remaining retention window. Once activated, direct Storage signing/download of finalized screenshots is denied; unfinished owner uploads remain readable for verification. Resume permissions are unchanged.
- Bids, candidate profiles and assignments delete permanently with their dependent history/files; profile/assignment deletion also removes their retained reporting aggregates. Account deactivation and monthly application retention remain.
- Temporary file-removal tasks survive failures and late uploads. The worker uses the existing five-minute second removal, then erases completed tasks/operations. No deleted application or file archive is retained.

## Release sequence

1. Run generated-type checks, lint, typecheck, unit/database tests, the desktop/mobile browser suite, and the production build. Preserve unrelated untracked audit documents.
2. Confirm `supabase/.temp/project-ref` is `aizorlyfggwbewetnwqm`. Run `supabase db push --linked --dry-run --yes`; only the two `202610290001`/`202610290002` migrations from this release should be pending on a fresh rollout.
3. Run the read-only `supabase/operations/screenshot-retention-preflight.sql`. Apply the compatibility migration with `supabase db push --linked --yes`. `file_retention_settings.enabled` defaults to false: old Storage signing and archive/trash writes remain compatible until activation.
4. Deploy this application to the linked Vercel production project. `.vercelignore` excludes local credentials, audit documents and test artifacts from the upload. Verify the new deployment is ready and the synthetic UI smoke passes while automatic cleanup remains off.
5. With production `.env.local` credentials, run `node --env-file=.env.local scripts/screenshot-retention-production.mjs --activate`. This also makes old archive/trash writes return a refresh-required error.
6. Run the same helper with `--smoke`, then `--drain`. It creates/removes only generated verification accounts/files. `--drain` runs bounded worker passes; `--status` reports counts only. Allow the real five-minute verification interval, then confirm no pending/failed cleanup or legacy archives remain. Supabase Cron continues autonomously; the daily Vercel cron remains a backup.
7. On an incident, use `--pause` to stop automatic expiry/legacy cleanup, retain the compatible application and fix forward. Migration 002 latches `cutover_completed`: pause never reopens old archive/trash writes or direct screenshot signing, and completed cleanup tasks still disappear. Already deleted data cannot be recovered by reverting application code. Do not redeploy the old automatic-preview app after enabling server-only screenshot signing.

The helper's production URL guard and explicit command mode prevent accidental staging/implicit activation. No credentials, customer identities or Storage paths are printed. Cleanup does not download image bodies; physical synthetic object absence is checked with Storage HEAD requests.

## Preflight evidence

Before migration: 27,297 bids; 2,043 trashed bids; 2 archived candidate profiles; 4 archived assignments; 10,703 screenshots using 1,215,099,380 metadata-reported bytes; 6,986 screenshots older than seven days; 211 superseded files; no pending Storage tasks. The `storage-cleanup` Cron job runs every minute and was active with zero recorded worker failures in the preceding hour. These are point-in-time counts; active production usage can change them.

## Local verification

Initial full verification passed 777 unit/database cases and 338 desktop/mobile browser cases. Additional regressions cover server-only signing, verified-upload retries and production guards. Final command totals and deployment/cleanup evidence are recorded below after rollout.

## Production rollout and bounded-worker correction

The compatible application was deployed from `bbaf1eb` as `dpl_6sHVLS7gAvfvNEkxV3dJ64R8mpgr`. The local Git email differed from the authenticated GitHub identity; the unpublished release commit was corrected to the verified noreply identity used by recent releases. No global Git configuration or shared history was changed.

The initial production smoke passed manager click-only preview, a real bidder upload without an image preview, concurrent proof/deletion RPCs, assignment/profile deletion scope, and explicit physical not-found checks. Verification resources were removed.

After activation, overlapping 500-file maintenance passes produced a timeout in the screenshot-retention phase. Storage calls themselves succeeded. Cleanup was paused; queued Storage tasks continued retrying. Logs established the failing phase, but did not establish whether the timeout was CPU or lock pressure. A scoping bug in the operator's synthetic expiry helper was also corrected, and its three leftover test accounts/files were explicitly recovered and removed.

Forward migration `202610290002_bounded_retention_workers.sql` and commit `d016b74` cap all SQL maintenance passes at 100 records, share a nonblocking maintenance lock, skip locked interactive rows, use fixed expiry bounds, and avoid redundant file detachment. Pause is now independent of the permanent application cutover. The worker logs sanitized SQLSTATE/timeout categories without database messages or paths.

The updated production application is `dpl_13rhqKPFTBCXynKrtvsu9UA66yCf`, ready at https://bidder-check.vercel.app. Local verification after the fix: 84 unit/database files, 787 tests, lint, generated-type check and production build pass; the unchanged UI has 338 passing desktop/mobile browser cases. The resumed production drain completed its first ten consecutive bounded passes without error; final cleanup and active expiry smoke results follow below.

## Final acceptance, 2026-10-29

- The bounded drain completed 19 successful manual passes alongside the autonomous minutely scheduler. Expired screenshots, trashed bids, archived candidate profiles/assignments and superseded files all reached zero. Physical Storage inventory reported zero orphan objects.
- The active production smoke passed seven checks: manager explicit preview; real bidder upload without preview downloads; concurrent proof/deletion RPCs with version conflict handling; expiry preserving applied state, original/latest dates and rate while denying screenshot access; assignment isolation; profile cascade deletion; and explicit Storage HEAD not-found verification. All three generated accounts and their files were removed.
- Final SQL verification at approximately 1:33 PM Central: `enabled=true`, `cutover_completed=true`, release backlog zero, failures zero, completed task rows zero, completed empty operation rows zero and synthetic profiles zero. One newer routine task remained in scheduled verification; it was outside the completed release backlog. The scheduler remains active.
- Tracked screenshot metadata fell from 10,896 files / 1,240,956,394 bytes immediately before activation to 3,561 files / 416,858,739 bytes. Storage object inventory fell from 10,821 to 3,577 objects. Counts are point-in-time snapshots during active production use; declared file sizes are not a billing measurement.
- Runtime error-log query for the fixed deployment returned zero cleanup errors. Both forward migrations are applied. No staging environment or customer-data reset was used.

Deferred housekeeping: two evidence/event lookup indexes introduced in migration 001 overlap earlier reverse-FK indexes. They were retained during the incident fix; a small amount of extra database index storage/write overhead remains. This does not retain screenshot bodies or deleted application history.

## Implementation choices

- Used a feature branch in the existing checkout to preserve installed dependencies, local deployment credentials and unrelated untracked audit documents. The working folder remains on `codex/screenshot-retention-deletion`; shared `main` was not changed.
- Excluded generated test-output and work directories from TypeScript inputs because an existing audit artifact contained an invalid `.ts` import. Files stored only in those output directories are not typechecked as application source.
- Ran the full local browser suite through a temporary config using the already running local test servers after Windows npm teardown left the first runner open. All 338 assertions ran; neither application authentication nor test assertions were bypassed.
- Corrected only the unpublished release commit's author to the authenticated repository owner's verified GitHub identity after Vercel's authorization rejection. Global Git identity settings and shared history were preserved.

The final newer routine task was independently checked using timestamps only: it had already been physically removed, had no failure/lease, and was not yet due for its five-minute second pass. The minutely scheduler was active. The local benchmark manifest check also passed (57 cases; it validates the matrix rather than running a hosted benchmark).
