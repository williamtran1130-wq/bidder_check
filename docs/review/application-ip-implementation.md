# Latest application IP implementation

Implemented 2026-10-31 in the shared workspace. No commit, push, deployment, or hosted mutation was performed.

## Behavior and storage

Migration `202610310002_latest_application_location.sql` replaces `screenshot_upload_contexts` with private `bid_application_locations`, keyed by `bid_id`. It backfills the last available `(uploaded_at,id)` record deterministically. Successful screenshot finalization validates server metadata and upserts the location under the existing bid/file locks in the same transaction as applying the screenshot. Finalized retries return before location writes; rejected/invalid uploads preserve the last successful location.

File expiry, screenshot replacement, manager correction and file cleanup no longer delete the bid location. Permanent bid deletion cascades it. Existing verified file timestamps and `screenshot_uploaded_at` list projection remain intact, preserving screenshot expiry deadlines. The migration replaces every remaining live cleanup dependency before dropping the history schema and history RPCs; it raises if any unexpected dependency remains.

A private, scoped SQL projection authorizes locations with `can_read`. `list_bids_v2` remains an invoker over RLS bids/files and returns nullable `applicationLocation` inline. Bidders see their own locations, clients/admins their existing authorized scope. Screenshot authorization was not expanded. The paginated result type requires the nullable location field; the shared base BidRow keeps it optional for non-list mutation payloads.

`ipCountry` defaults to `all`; values are `all`, `US`, `non-US`, `unknown` and uppercase two-letter country codes. Both list branches apply the predicate before pagination/counts. `countryOptions` ignores only its own country predicate and respects other filters, including selected status and repeated screenshot sizes. Filtering uses saved country even after correction; Unknown includes never-applied bids and unavailable/unrecorded countries.

The column is visible to all supported roles and uses inline fields with no metadata requests. Applied US rows show a green check/tint, other or unknown applied rows amber warning/tint, unapplied rows remain neutral. Labels describe the assessment in text. Opaque selection/focus cell backgrounds override row tint. The single select includes readable country names, and changing it resets pagination/selection. The preview reuses the inline latest location. History actions/types/UI/request queue are removed.

## Files

- SQL: `supabase/migrations/202610310002_latest_application_location.sql`.
- UI: `bids.tsx`, `bid-grid.tsx`, `applied-ip-location-cell.tsx`, `upload-details.tsx`, `screenshot-cell.tsx`.
- Contracts/read logic: `application-location.ts`, `bid-list.ts`, `workspace-types.ts`, `upload-context-types.ts`, `read-services.ts`, `read-keys.ts`, `read-scope.tsx`.
- Deleted: upload-context server actions, client and queue; their obsolete queue tests and preview action stub.
- Verification: upload-context capture/action/database/read tests; screenshot retention/compression expectations; desktop/mobile IP and preview browser tests; preview sample-data/actions/read-client/Vite alias; production/staging private-review smoke scripts and their tests.
- Shared-file integration: removed obsolete notification helper reads from `read-services.ts` at root request, and added `invalidateReports()` to bid snapshot refresh.

## Verification evidence

- `npx.cmd vitest run tests/upload-context.test.ts tests/upload-context-actions.test.ts tests/upload-context-database.test.ts tests/upload-context-read.test.ts tests/screenshot-retention-database.test.ts tests/screenshot-compression-database.test.ts tests/review-correctness-database.test.ts tests/private-review-production-smoke.test.ts tests/private-review-staging-smoke.test.ts`: 9 suites, 111 tests passed.
- `npx.cmd playwright test e2e/applied-ip-location.spec.ts e2e/upload-context.spec.ts --project=desktop --workers=1`: 8 passed.
- Same browser tests with `--project=mobile`: 8 passed.
- `npx.cmd tsc --noEmit --pretty false`: passed after shared integration updates.
- Focused ESLint: passed with no errors or warnings.
- Additional regression suites `file-read-scope`, `screenshot-size-query`, `repeated-size-query-plan` and `resume-options`: 4 suites, 77 tests passed. Historical comparison helpers explicitly exclude only the newly added list fields, and plan helpers extract the complete grouped SELECT including location CTEs while retaining performance assertions.
- Final whole-workspace `npx.cmd tsc --noEmit --pretty false`: passed.
- Added independent selection/focus override browser check: desktop and mobile both passed (18 browser checks total).

The PGlite retry tests execute concurrent queued calls within one PGlite instance. They verify idempotence and atomic state, not independent PostgreSQL connection scheduling. The staging helper now checks the same latest-record contract but was only tested locally with mocks; no hosted smoke run was executed. Historical review-correctness tests intentionally stop at migration 019 and retain historical-table references.

## Integration notes

Root owns read-handler/read-client transport removal and schema regeneration. The upload-contexts operation should remain removed. The bid read schema must preserve optional `ipCountry`; read-services supplies its default/validation. Public database types must include `bid_application_locations` and remove the old history table/RPCs; `private.application_locations()` stays outside the public schema. The new location table has no authenticated direct SELECT/write grant, only service-role SELECT; writes happen within the service finalizer. Migration 002 follows root migration 001.
