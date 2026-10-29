# Seven-day screenshots and permanent deletion

This release uses production only. It supersedes staging-first instructions in older deployment records for this feature. No existing migration is rewritten and no global reset is performed.

## Behavior

- Screenshots expire 168 hours after successful verification. Application dates, status, rate, interviews and reports remain unchanged. A current timestamp/hash snapshot on the active bid preserves rejected-proof protection after the image is deleted.
- Bidders see status only. Managers open screenshots explicitly. The server authorizes the caller-scoped file and caps its signed URL at the remaining retention window. Once activated, direct Storage signing/download of finalized screenshots is denied; unfinished owner uploads remain readable for verification. Resume permissions are unchanged.
- Bids, candidate profiles and assignments delete permanently with their dependent history/files; profile/assignment deletion also removes their retained reporting aggregates. Account deactivation and monthly application retention remain.
- Temporary file-removal tasks survive failures and late uploads. The worker uses the existing five-minute second removal, then erases completed tasks/operations. No deleted application or file archive is retained.

## Release sequence

1. Run generated-type checks, lint, typecheck, unit/database tests, the desktop/mobile browser suite, and the production build. Preserve unrelated untracked audit documents.
2. Confirm `supabase/.temp/project-ref` is `aizorlyfggwbewetnwqm`. Run `supabase db push --linked --dry-run --yes`; only `202610290001_screenshot_retention_deletion.sql` should be pending.
3. Run the read-only `supabase/operations/screenshot-retention-preflight.sql`. Apply the compatibility migration with `supabase db push --linked --yes`. `file_retention_settings.enabled` defaults to false: old Storage signing and archive/trash writes remain compatible until activation.
4. Deploy this application to the linked Vercel production project. `.vercelignore` excludes local credentials, audit documents and test artifacts from the upload. Verify the new deployment is ready and the synthetic UI smoke passes while automatic cleanup remains off.
5. With production `.env.local` credentials, run `node --env-file=.env.local scripts/screenshot-retention-production.mjs --activate`. This also makes old archive/trash writes return a refresh-required error.
6. Run the same helper with `--smoke`, then `--drain`. It creates/removes only generated verification accounts/files. `--drain` runs bounded worker passes; `--status` reports counts only. Allow the real five-minute verification interval, then confirm no pending/failed cleanup or legacy archives remain. Supabase Cron continues autonomously; the daily Vercel cron remains a backup.
7. On an incident, use `--pause` to stop automatic expiry/legacy cleanup, retain the compatible application and fix forward. Already deleted data cannot be recovered by reverting application code. Do not redeploy the old automatic-preview app after enabling server-only screenshot signing.

The helper's production URL guard and explicit command mode prevent accidental staging/implicit activation. No credentials, customer identities or Storage paths are printed. Cleanup does not download image bodies; physical synthetic object absence is checked with Storage HEAD requests.

## Preflight evidence

Before migration: 27,297 bids; 2,043 trashed bids; 2 archived candidate profiles; 4 archived assignments; 10,703 screenshots using 1,215,099,380 metadata-reported bytes; 6,986 screenshots older than seven days; 211 superseded files; no pending Storage tasks. The `storage-cleanup` Cron job runs every minute and was active with zero recorded worker failures in the preceding hour. These are point-in-time counts; active production usage can change them.

## Local verification

Initial full verification passed 777 unit/database cases and 338 desktop/mobile browser cases. Additional regressions cover server-only signing, verified-upload retries and production guards. Final command totals and deployment/cleanup evidence are recorded below after rollout.
