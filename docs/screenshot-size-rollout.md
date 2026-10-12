# Screenshot file size matching rollout

This release adds exact-byte metadata to manager `list_bids_v2` rows and manager screenshot controls in Bids and embedded bidder activity. Matching size is a review aid, not proof of matching image content. Existing file access, screenshot-presence controls, period defaults and bidder views stay in place.

The release sequence is `202610120008_screenshot_size_matching.sql`, `202610120009_file_read_scope.sql`, `202610120010_list_bids_custom_plan.sql` and pending `202610120011_list_bids_filtered_projection.sql`, after existing migrations through `202610120007`. Before applying migration 011, record the final artifact and checksum and require independent review. Deploy migrations first: additional manager JSON fields and supported sort IDs are compatible with the previous application. The new application's optional metadata transport renders an attached screenshot with unavailable metadata as **Size unavailable**. Do not deploy the feature before these migrations and then interpret that fallback as successful feature verification. Keep financial enforcement and invoker/RLS safeguards in place during application rollback; do not remove earlier migrations or regrant financial columns.

The hosted staging benchmarks after 008 and after 009 each failed their first ordinary found-date case with statement-timeout code `57014`. The 008 plan exposed repeated file RLS work and repeated size aggregate/count joins. Additive migration 009 expresses the equivalent file SELECT scope through the existing readable-bid scope and computes each full-result size count once in the materialized evidence snapshot. The second failure exposed expensive cached generic plans in the actual parameterized RPC, despite a fast literal SELECT diagnostic. Diagnostic timings are not benchmark acceptance.

Migration 010 sets `plan_cache_mode = force_custom_plan` only on `public.list_bids_v2(jsonb)`. The function setting applies during its execution and nested statements/helpers; PostgreSQL restores the caller's setting on function exit. It does not change the 009 SQL body, invoker behavior, grants, global settings or timeouts. The post010 first case completed 25 samples with five readers and no `57014`, but raw p95 2,204.7205ms and maximum 2,269ms failed the unchanged p95 target below 2,000ms. Cleanup of that failed fixture is ongoing. Migrations 008, 009 and 010 remain immutable, and all three failed benchmark receipts remain failures.

Pending migration 011 conditionally projects auxiliary sort-only fields in the initial materialized `filtered` CTE and makes the pure `status_filtered` wrapper explicitly `NOT MATERIALIZED`. It must preserve required identity/status/tie fields, the single materialized current-evidence snapshot and full-result counts, explicit safe page output, invoker/STABLE/search_path/ACL and 010's function-local custom-plan clause. No policy, grant, global setting, timeout or benchmark change is in scope. An immutable local prototype's 120 RPC executions, 40 plans and 90 passing candidate JSON comparisons support the direction: median found-date timing 197→140ms, size timing 212→168ms, temporary writes 1,876→286 blocks and reads 2,814→858. These local measurements do not establish final 011 regression coverage or hosted acceptance. Review and freeze the actual migration/tests, then require a new complete post011 benchmark before staging application acceptance or production rollout.

## Local and staging gates

Use a reviewed release checkout. Record its complete Git SHA, migration artifact checksum, target reference and deployed application SHA in the release ledger. Run the required lint, typecheck, unit/database, browser and build checks and independent review before hosted writes. The safe script checks below do not read environment files or call hosted services:

```powershell
node --check scripts/screenshot-size-staging-benchmark.mjs
node scripts/screenshot-size-staging-benchmark.mjs --self-test
node --check scripts/reporting-production-smoke.mjs
```

Run the baseline **before** migration 008, with the current schema through 007. If 008 is already applied, preserve the completed pre008 baseline receipt rather than running `--before` against the new response shape. Use process-scoped staging credentials from the established approved mechanism or an existing dedicated staging environment file; never edit the original environment files. The URL must be exactly `https://kdmvludtvhuuewmhurpw.supabase.co` and `--staging-ready` is mandatory even for cleanup. Choose a fresh receipt filename for every run; an existing receipt is never overwritten by a new benchmark.

```powershell
node --env-file=.env.staging scripts/screenshot-size-staging-benchmark.mjs --before --staging-ready --receipt .superpowers/sdd/2026-10-12-screenshot-size-matching/hosted-receipts/before-008.json
if ($LASTEXITCODE -ne 0) { throw "Baseline or cleanup failed; inspect the sanitized receipt" }
```

Baseline mode exercises only ordinary found-date ordering and requires the pre008 response without metadata fields. It seeds the same metadata fixture shape as the post run, including 25,000 main-workspace bids, five additional bids in a separate synthetic workspace and finalized/current, unique, repeated, near-equal, manual, missing, unfinalized, historical, mismatched-scope and trashed examples. It cleans the whole fixture before proceeding. Require `passed: true`, `cleanupComplete: true`, zero `cleanupCounts` and `signupNotificationCount: 0` in the baseline receipt.

Use an isolated Supabase CLI workdir linked explicitly to the dedicated staging project. Preserve frozen migrations 008/009/010 and failed `after-008.json`, `after-009.json` and `after-010.json` receipts. Require complete cleanup of every failed fixture, including the ongoing failed010 cleanup, before applying 011 or seeding another benchmark. Inspect migration history and `db push --linked --dry-run`; current staging is through 010 and must show exactly 011 pending once the actual artifact is reviewed and frozen. On a fresh target through 007, require exactly 008, 009, 010 and 011 pending. Resolve any history mismatch before applying. Retain prior independent review evidence and require 011's complete-output/scope/status/sort differential tests, snapshot and custom-plan preservation checks plus independent review. Apply only reviewed pending artifacts, wait for PostgREST schema-cache refresh and rerun the unchanged full-size benchmark with a new receipt:

```powershell
node --env-file=.env.staging scripts/screenshot-size-staging-benchmark.mjs --staging-ready --keep-fixture --receipt .superpowers/sdd/2026-10-12-screenshot-size-matching/hosted-receipts/after-011.json
if ($LASTEXITCODE -ne 0) { throw "Post benchmark failed; inspect fixture cleanup receipt" }
```

The post011 gate covers authenticated client, admin and bidder sessions, full and recent date ranges, found-date ordering and both size directions. Keep the same 25,000 main bids, representative metadata, five concurrent readers and at least 25 samples per role/range/sort case across first, second, middle and last pages. It independently computes the full filtered result's exact counts, NULLS LAST and tie order, and verifies bidder field omission/unsupported-sort fallback, cross-workspace/bidder restrictions and denied direct financial-column reads. Additional cases check admin results across both isolated workspaces, a bidder-restricted manager filter and existing screenshot-presence ordering. Every measured case requires raw p95 below 2,000ms; any provider error, including `57014`, fails. Preserve the pre008 baseline, failed 008/009/010 and fresh 011 receipts; compare ordinary baseline/post cases and resolve regressions even when a new-feature case meets the threshold. Do not increase statement timeouts, reduce the fixture/concurrency/sample counts or waive cleanup to obtain a pass.

The bootstrap account uses a uniquely marked `client_provisions` reservation with a single existing active approved **staging** admin UUID as `created_by`. That admin is read only and is never authenticated or updated. All other provisions reference the synthetic owner. Planned reservation/Auth IDs and marked emails are flushed to the receipt before writes. Managed provisioning avoids public signup notifications/pushes; no public signup fallback exists. No customer workspace is seeded or cleaned.

`--keep-fixture` is allowed only on a fully passing post benchmark. It deliberately leaves `fixtureRetained: true` and `cleanupComplete: false` so the staging app can be checked against the same synthetic data. A failed run attempts cleanup automatically. Before mode always cleans. Deploy the reviewed SHA to staging/Preview with the correct staging environment and configured protection bypass, then run the additive smoke:

The smoke uses generic existing actor selection. If staging already has other bids, it may select those actors rather than the retained fixture. Before claiming synthetic-fixture browser coverage, the parent must verify and record that the chosen manager and bidder identities match the retained receipt's planned synthetic identities. Otherwise record the selected scope as existing-data coverage; retaining a fixture alone does not establish that the browser exercised it.

```powershell
node --env-file=.env.staging scripts/reporting-production-smoke.mjs --staging-read-only --arrangements --screenshot-sizes
if ($LASTEXITCODE -ne 0) { throw "Staging application smoke failed" }
```

The smoke retains existing reporting, financial, period-default and role checks. Its independent safe bid/file projections use the same authenticated caller's RLS across all authorized workspaces. New checks reconcile ordinary/size ordering and exact filtered counts, test both manager sort controls and badges in Bids and bidder activity, exercise exact-byte popovers with keyboard and click, and confirm bidder controls/metadata are absent. Bids uses the complete authorized result; bidder activity and its RPC reconciliation use the selected bidder's complete authorized result. When independent source facts contain valid metadata, the largest-first view must render a badge whose exact bytes and global count agree with those facts. A no-data outcome is accepted only when source facts establish absence. Missing duplicate sizes is legitimate; receipts distinguish data availability from assertions. Customer/application data are read only. Authentication uses the existing no-email generated link exception and revokes only its isolated local sessions.

The benchmark does **not** upload storage objects. Its synthetic metadata can exercise badges while thumbnails fail to load. Do not claim private preview/download/upload behavior was verified by these fake objects. Record existing local lifecycle test evidence and any real-file hosted smoke performed separately, including desktop/mobile, light/dark, touch/keyboard, neutral unique sizes, repeated groups across pages, unavailable metadata and refresh behavior where exercised. This release does not add a hosted uploader. Do not create production duplicates or edit production customers for coverage.

## Cleanup and interrupted-run recovery

Run after staged app acceptance, including when acceptance fails:

```powershell
node --env-file=.env.staging scripts/screenshot-size-staging-benchmark.mjs --cleanup-only --staging-ready --receipt .superpowers/sdd/2026-10-12-screenshot-size-matching/hosted-receipts/after-011.json
if ($LASTEXITCODE -ne 0) { throw "Fixture cleanup incomplete; preserve receipt for recovery" }
```

The same command is idempotent after partial cleanup or a killed process. Recover the failed 010 run only from its original receipt; require complete cleanup before applying 011 or seeding another benchmark:

```powershell
node --env-file=.env.staging scripts/screenshot-size-staging-benchmark.mjs --cleanup-only --staging-ready --receipt .superpowers/sdd/2026-10-12-screenshot-size-matching/hosted-receipts/after-010.json
if ($LASTEXITCODE -ne 0) { throw "Failed 010 fixture cleanup incomplete" }
```

The failed 009 receipt remains preserved. If its cleanup needs recovery, use only its original scope:

```powershell
node --env-file=.env.staging scripts/screenshot-size-staging-benchmark.mjs --cleanup-only --staging-ready --receipt .superpowers/sdd/2026-10-12-screenshot-size-matching/hosted-receipts/after-009.json
if ($LASTEXITCODE -ne 0) { throw "Failed 009 fixture cleanup incomplete" }
```

The failed 008 receipt is also preserved. If its cleanup needs recovery, use only its original scope:

```powershell
node --env-file=.env.staging scripts/screenshot-size-staging-benchmark.mjs --cleanup-only --staging-ready --receipt .superpowers/sdd/2026-10-12-screenshot-size-matching/hosted-receipts/after-008.json
if ($LASTEXITCODE -ne 0) { throw "Failed 008 fixture cleanup incomplete" }
```

For a failed/interrupted baseline use its original receipt:

```powershell
node --env-file=.env.staging scripts/screenshot-size-staging-benchmark.mjs --cleanup-only --staging-ready --receipt .superpowers/sdd/2026-10-12-screenshot-size-matching/hosted-receipts/before-008.json
```

The receipt is created exclusively before writes, contains planned synthetic identities and observed workspaces, and is flushed and atomically replaced as work progresses. Recovery requires an explicit receipt beneath `.superpowers`, the exact staging target, valid marker/UUID/email identities and matching surviving Auth/profile/workspace ownership. It discovers trigger-created workspaces by the pre-recorded synthetic owner IDs, tolerates already-missing Auth users and fails closed for foreign memberships, unmarked fixture-scope rows or foreign account events. It never deletes by email wildcard or uses a customer-scope purge/reset RPC.

Cleanup deletes scoped bid events, clears bid/resume file pointers, then removes files, bids, aggregates, assignments, profiles, invitations/memberships and workspaces in foreign-key order. It removes exactly the planned provisions, synthetic account/notification records, profiles and Auth users. Verification requires zero residual fixture rows and Auth identities. A receipt's `passed` is the benchmark result; `cleanupComplete` is a separate gate. Retained fixtures are intentional only until staged acceptance ends. Never proceed to production with unresolved fixture cleanup. Preserve the sanitized JSON and native command exit codes outside Git; a PowerShell wrapper must distinguish real CLI failure from harmless stderr warnings.

## Production gate

After 011 is frozen and independently approved, the unchanged full benchmark passes on it, staged application acceptance passes and all fixture cleanup is complete, verify production's existing history through 007. Dry-run the same immutable migration artifacts and require exactly 008, 009, 010 and 011 pending. Apply all four migrations first, then deploy the **exact tested complete Git SHA** using production environment variables. Record the production deployment ID/alias, artifact SHA/checksums, all four migration receipts and passing post011 performance/cleanup evidence; do not substitute a new working-tree build or a different commit. Run:

```powershell
node --env-file=.env.local scripts/reporting-production-smoke.mjs --production-read-only --arrangements --screenshot-sizes
if ($LASTEXITCODE -ne 0) { throw "Production read-only smoke failed" }
```

Production read-only reconciliation can encounter active edits between its independent source read and RPC snapshot. If this produces a mismatch, preserve sanitized phase/exit evidence, investigate the concurrent change and rerun read only; do not relax exact counts or write customers to manufacture a pass. Record unavailable-data coverage honestly. If the app must roll back, use the previous financial-safe compatible SHA and retain all four additive migrations. No backfill or screenshot download is required for this release.
