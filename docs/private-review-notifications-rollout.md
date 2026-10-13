# Notifications and private screenshot review rollout

This release adds Central Time message scheduling, paged notification reads, bounded push delivery, manager-only repeated screenshot sizes and upload context, and searchable resume assignments. Existing period defaults and review-queue behavior stay intact.

## Release order

1. Verify the current deployed schema through `202610120012`, scheduler health, and production bid volume using read-only queries. Never print Vault values, raw customer locations, push endpoints, or credentials.
2. Run the ordinary-query staging baseline before applying migrations. Use the guarded benchmark with `--ordinary-only --representative-bids <verified count>`. Its 25,000 synthetic bids must be at least twice that count. Require cleanup to finish before the next hosted step.
3. Apply the reviewed forward migrations beginning with `202610120013_notification_reliability.sql`, `202610120014_repeated_screenshot_sizes.sql`, and `202610120015_screenshot_upload_context.sql`, followed by `202610120016_repeated_size_sort_projection.sql`, `202610120017_evidence_snapshot_projection.sql`, and `202610120018_grouped_evidence_size_counts.sql`, to staging. Keep historical migrations untouched. These additions preserve legacy application entry points during rollout.
4. Run the full staging benchmark: 57 cases, five concurrent authenticated readers, 25 samples per case. Require every unrounded p95 to remain below 10,000 milliseconds, exact result/count reconciliation, and no statement timeouts. Compare its ordinary cases with the baseline. Retain the marked fixture only for acceptance using `--keep-fixture`.
5. Deploy the exact reviewed Git SHA to the staging alias. Verify its project, branch, SHA, environment, and READY state before assigning the alias.
6. Confirm scheduled in-app publication through the real cron, within two minute cycles, without an open browser or direct worker trigger. Observe another cycle to rule out duplicate inbox entries. Test browser push separately; a provider's acceptance does not prove device receipt.
7. Verify finalization atomicity and immutable upload context using isolated fixture actors, including overlapping transports, retries, replacement/file cleanup, bid deletion, and manager/bidder permissions. Verify trusted platform-header capture through the deployed application. Do not print actual network addresses into release artifacts.
8. Clean up every fixture and temporary auth session using its original durable receipt. Require zero residual fixture rows and accounts.
9. Apply the same reviewed forward migrations to production before releasing the same tested application SHA. Verify the production alias, permissions, repeated filtering, notification cron outcomes, and read-only reporting. Do not create customer messages or modify customer applications for a smoke check.

## Operator behavior

- In Notifications, choose recipients, write the message, then select Now, Once later, Daily, or Selected weekdays. New recurring messages start at 09:00 America/Chicago. Schedules repeat the authored message. A resumed schedule waits for its next future slot.
- Drafts are not delivered. Publishing a Now draft uses publication time. Expired one-time schedules need a new future time or explicit Send now. Paused schedules remain paused while edited.
- Inbox and message lists use 50-row cursors and one foreground refresh cycle. Network failures retain only matching-scope successful results and show retry guidance. An uncertain save preserves input and must be checked in the schedule list before retrying.
- Clients/admins can choose Screenshot → Repeated sizes only. Exact file bytes are compared across the full current filtered result before pagination. Each status count computes its own matching groups, so status counts need not add up. Equal size does not establish equal image content.
- Bidders receive no size metadata, repeated-size controls, or upload IP/location details. Unsupported requests are normalized on the server. Normal screenshot upload/view and presence filtering remain available.
- Upload details reflect the finalization request's approximate network location, which may represent a VPN or proxy. Old uploads remain Not recorded. Context survives replacement and file cleanup but follows permanent bid deletion; it is excluded from retained aggregates.

## Rollback and recovery

Keep the additive migrations if the application must roll back to the previous financial-safe release. Older application finalization remains compatible but does not capture new context. New private tables remain access restricted. Restore the tested application after correcting the issue; do not backfill historical network locations.

Benchmark and smoke receipts live beneath the ignored `.superpowers` directory. Preserve failures and native exit codes alongside successful runs. Cleanup must validate the exact staging project and planned synthetic identities; never delete by email wildcard, reset a workspace, or use customer-scoped purge operations. A failed response is not proof that a mutation did not commit.

## Verification record

Release evidence is recorded in `.superpowers/sdd/2026-10-12-reliable-notifications-private-review/`. Independent reviews cover notifications, repeated-size SQL, upload-context lifetime/access, resume UX, and shared integration. Hosted measurements, actual cron delivery, cleanup, and deployment identifiers are recorded after execution.

Before staging application rollout, the frozen implementation passed 467 unit/database tests in 46 files, 186 desktop/mobile browser cases, ESLint, TypeScript, and a production build on Node 22. The ordinary staging baseline passed 21 cases / 525 authenticated reads with five concurrent readers; its worst raw p95 was 1,945.735 milliseconds. All baseline fixture and Auth counts were zero after cleanup. Staging successfully applied migrations 013–015. The expanded benchmark and deployed acceptance remain separate release gates.

The first expanded run failed with SQLSTATE `57014` for repeated-size filtering plus ascending size order. Its authenticated PostgreSQL plan underestimated the materialized evidence to one row and chose a nested loop that repeatedly scanned the same evidence for sorting after eligibility filtering. This is a release blocker until the forward query-plan correction passes the full matrix. Keep this failed receipt and its cleanup record; do not raise the 10-second ceiling or overwrite the run.

SQL016 carries the size already joined for repeated eligibility into sorting and disables that redundant join. Its actual-plan regression failed on SQL014 and passed on SQL016 in both directions; the hosted estimated plan confirms the removed scan. Independent review approved the correction and verified that 013–015 were unchanged. The expanded unit/database suite passed 488 tests in 48 files. The failed staging fixture was completely removed before applying SQL016 and beginning a fresh full benchmark.

The SQL016 rerun passed both all-time repeated-size orders, then failed on recent-period ordinary descending size order. Its earlier recent ascending cases approached eight seconds. A captured first-page plan did not show the earlier quadratic scan; timings collected during cleanup are diagnostic context, not release measurements. SQL017 replaces evidence re-joins with one row-preserving snapshot, carries metadata through pagination, and avoids materializing the filtered base twice. Require its fresh full matrix to pass before rollout; preserve both previous failures and their cleanup records.

SQL017 still produced intermittent hosted timeouts. A subsequent instrumented run observed active paging and substantial disk I/O around the slowdown, without sampled lock blockers. The sampling gap and cached resource metrics prevent attribution to the exact canceled statement. These failed runs remain release failures; a successful isolated query is not a replacement for the full matrix.

SQL018 keeps the authorized evidence snapshot but aggregates narrow byte-size groups instead of sorting all evidence rows for window counts. A controlled local comparison using the frozen 25,000-bid fixture exercised 160 authenticated plans and RPC calls. All 64 SQL018 results exactly matched their SQL017 counterparts, and temporary-file reads/writes fell from 222–226 blocks for all-time SQL017 cases to zero in every SQL018 case. The grouping used at most 297 KiB, compared with the previous evidence sort's 2,032 KiB. These are local footprint measurements, not a hosted latency guarantee. The complete 510-test suite passed with two workers and unchanged test timeouts; the initial default-parallel run hit two local setup/process timeouts, preserved separately. TypeScript and ESLint also passed. The unchanged application previously passed 186 browser cases and the production build. SQL018 must still pass the complete hosted matrix and deployed acceptance before production rollout.

Serialize Supabase CLI operations for a project: concurrent CLI commands can rotate the same temporary login credential and cause a diagnostic connection failure. This does not apply to the five independent authenticated application readers used by the benchmark.

After production rollout, run `scripts/reporting-production-smoke.mjs --production-read-only --arrangements --screenshot-sizes --private-review`. The optional private-review checks reuse the existing isolated sessions, permit only authenticated read endpoints, verify repeated-size counts and bidder fallback, and test notification/private-context access. Results contain only check names, timings, and coverage flags. A false coverage flag means no existing record exercised that case; it must not be described as a successful new upload or device-push delivery test.
