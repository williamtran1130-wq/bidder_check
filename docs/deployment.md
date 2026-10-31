> Notification retirement, 2026-10-31: local implementation removes notification delivery and message management. Apply `202610310003_retire_notifications.sql` with the compatible application release; it unschedules only `bidder-check-notifications` and removes notification-only data and Vault entries. Storage cleanup remains active. Production application/schema changes have not been executed by this implementation task. Historical notification verification and credential instructions below are superseded. See [implementation and release notes](review/notification-retirement-implementation.md).

# Deployment handoff

## Current release — mail metrics and original theme, 2026-10-31

Production source `db4986e6f5ad4f58388702d87ee6447a5f700a99`, deployment `dpl_6371qpJrhGKzkH8ZGp7KE85AQL6k`, is READY at https://bidder-check.vercel.app. Mail Check [0.5.1](https://github.com/DevTech06130324/mail-check/releases/tag/v0.5.1) is published with the matching original lavender category palette and Windows sign-in fix.

Overview adds confirmation messages to activity and bidder/profile comparisons, moves email sections below comparisons, and remembers the activity table's collapsed state per account/workspace/browser. Earnings adds Applications received beside application counts without changing earnings calculations. Interviews uses Mail Check invitation messages throughout; the invitation/application percentage is a period ratio, not individually matched conversion. Missing or stale collection coverage is partial, and incomplete coverage suppresses ratios. Admin reports require workspace selection for mail metrics.

No migration, new dependency or sync-format change. [Release evidence](release-evidence/2026-10-31-mail-metrics.json) records 893 unit/database and 348 browser cases passing locally and in [Linux/Windows CI](https://github.com/DevTech06130324/bidder-check/actions/runs/41202641218), packaged desktop validation and 12 production acceptance checks. All four synthetic acceptance accounts and their records were removed. Installer SHA-256: `e3d4a2b1aecdd1c2eb8c78e2abfb994961d8b3f3d6e623bf7e6bbdb61c3a3352`.

Rollback deployment: `dpl_BXwdhd7g6XjCbEdKmAyfftYuNRvk`. Retain Mail Check 0.5.0 assets; no database rollback is required.


## Previous release: screenshot retention and permanent deletion, 2026-10-29

Production-only release: `d016b74`, deployment `dpl_13rhqKPFTBCXynKrtvsu9UA66yCf`, ready at https://bidder-check.vercel.app. Migrations `202610290001` and `202610290002` are applied. Seven-day screenshot retention and permanent bid/candidate-library deletion replace the older preview/archive/trash behavior described in historical sections below. Account deactivation and monthly application reporting retention remain.

See the [current rollout and verification record](screenshot-retention-deletion-rollout.md) for activation, bounded worker recovery, final cleanup counts and production smoke results. Existing staging references below are historical, not a prerequisite for this release.


## Previous release — reliable reporting and private bidder workflows, 2026-10-12

Implementation commit `3b4f1e4` was initially promoted to production as
`dpl_55zg66qBd5tnkXKmoW2AwKqCaHuX` at https://bidder-check.vercel.app.
The compatible staging application is `dpl_72wNQuRjHPCRL2WT4xi9waXhPpEx`
at https://bidder-check-staging.vercel.app. Both databases have all four
`202610120001` through `202610120004` migrations. Compatibility migrations
001-003 were applied first, followed by the app, then financial enforcement 004.
Both deployment dry runs were reviewed; no historical migration was rewritten
and no production customer-data reset was performed.

The release adds calendar periods in Central Time, a focused dashboard with
cohort comparisons, manager-only financial values, status-only import previews,
reliable batch retries and complete assignment loading. Dashboard reporting
now materializes authorized scope once and compresses dated events before
aggregation. The same authenticated current-month production diagnostic fell
from 6,666 ms on the legacy function to 146 ms on v2, with no temporary spill.
This is a single execution comparison, not a production percentile.

The staging report acceptance benchmark passed 450 authenticated requests at
five-reader concurrency against 25,000 synthetic bids plus retained history.
The slowest dashboard p95 was 1,041 ms; all expected bidder financial denials
and fixture reconciliation checks passed, with no reporting statement timeout.
The independent [GitHub verification run](https://github.com/DevTech06130324/bidder-check/actions/runs/38253491942)
passed lint, typecheck, build, 175 unit/database tests and all 120 desktop/mobile
browser tests. Production signup/approval/password/sign-out, worker auth, safe
listing and direct financial-column denial checks passed; their single synthetic
pending account was removed.

The live production reporting smoke passed all 21 API/browser checks using
temporary sessions for existing manager and bidder accounts. Both roles loaded
This month and All time dashboards and interview reports. Manager earnings
reconciled with dashboard totals; bidder financial fields and legacy endpoints
were denied, and `/earnings` redirected to the dashboard. All eight report
page/period checks had zero application error alerts. Only Next.js's separate
accessibility route announcement is excluded by the smoke assertion. Verification
sessions were signed out without modifying customer applications.

An existing service-only bulk-reset routine reached its eight-second REST
deadline when the hosted smoke combined its maintenance test with the entire
large benchmark fixture. Benchmark thresholds remain unchanged; captured
benchmark IDs are now removed separately before the original reset/file-cleanup
behavior check. This routine is not part of dashboard or bid-entry requests.
See [the measured evidence and maintenance limit](reporting-performance.md).
Post-enforcement rollback must retain the compatible safe projections and v2
list/report calls; do not roll back to the older broad financial reads.

## Previous release — signup alerts and workflow fixes, 2026-10-05

Implementation commit `54cc5fe` is pushed to `main` and READY in production as
`dpl_CXK9o3BC9hyAesqfQrSzEB283EhU` at https://bidder-check.vercel.app.
Staging is `dpl_HPqHzBVE3aNNqxLn2eAVWXK41rRz` at
https://bidder-check-staging.vercel.app. Both databases include migrations
`202610050004_signup_alerts_retention.sql` and
`202610050005_push_device_ownership.sql`; the production ledger matches every
local migration. This release performs no customer-data reset.

Public registrations create private admin approval alerts with authenticated
review links. Admin inbox/push controls coexist with message management. New
candidate profiles default to two calendar months; existing retention settings
are preserved. Assignment dialogs select and finalize a PDF in one workflow,
retaining drafts and incomplete IDs for retry. Import remains clickable for
validation and freezes uncertain submissions for idempotent retry. Dashboard
bucket labels and boundaries use CT without shifting calendar dates.

The earlier HTTP-200-only notification checks were insufficient: the session
Proxy redirected bearer-only worker requests to login HTML. This release
exempts the exact cron endpoints and public PWA assets from session handling;
cron endpoints still authenticate their server-only bearers. Hosted checks now
require JSON. Both Vault endpoint URLs use their stable environment aliases.
Supabase scheduler calls returned HTTP 200 with JSON (`schedule.occurrences`
and `pushConfigured: true`) in staging (request 540) and production (request 435).
A staging scheduled message published through the real HTTP worker exactly once
across retries, without calling the schedule-processing RPC directly.

Verification: lint, typecheck, production build, 99 unit/database cases
(43 database), and 70 desktop/mobile browser cases passed. The full hosted staging
journey passed 21 checkpoints, including invalid-PDF retry on the same assignment,
private downloads, application approval, evidence/earnings, import concurrency,
retention, and synthetic cleanup. Production smoke verified private signup
alerts, pending-account routing and authorization, password change, sign-out,
worker 401 without a bearer, and JSON with a valid bearer. Generated verification
accounts/files were removed; the designated administrator remains active.

VAPID configuration is now present with separate staging/production key pairs.
Real browser push delivery remains unverified: Chrome/Edge provider registration
was refused in the automated environment. Provider errors are visible and the
inbox stays usable; service-worker activation is awaited before subscription.
Do not interpret `pushConfigured` or provider acceptance as delivery or reading.

`scripts/production-smoke.mjs` requires the production worker credential in
`NOTIFICATION_WORKER_SECRET` as well as the usual local Supabase credentials.
The release check sourced it from Vault into the test process only, without
printing it or writing it into Git. GitHub run
[37373752261](https://github.com/DevTech06130324/bidder-check/actions/runs/37373752261)
completed successfully, including lint, typecheck, tests, build, and browser checks. The
previous run could not acquire a hosted runner and executed no verification steps.

The sections below are historical release records; this section supersedes their
older notification-verification and VAPID status.

## Admin visibility fix — 2026-10-01

The Users hierarchy previously rendered only client-owned groups, hiding bidders
whose workspace owner is an admin (for example, after promoting a client).
Production investigation confirmed one such bidder, with a valid membership.
Users now includes a searchable **Bidders without a client** section in the admin
Active/Archived views, using the existing detail links and management actions.
No migration, reassignment, or permission change is required.

Verification: the browser regression failed before the fix and passed afterward;
77 unit/database tests, 44 desktop/mobile browser tests, lint, type checking, and
the production build passed. Preview `dpl_2jHuMLsf58SvDquhPYnsSW1aVMYH` passed the
targeted hosted check for finding, editing rates, and opening the bidder profile.
`scripts/people-visibility-smoke.mjs` creates and removes only synthetic staging
accounts and refuses to run against production.

Production deployment `dpl_7iwTycA81doPV3QKL6mqPSmRXgwq` is READY at
https://bidder-check.vercel.app. A temporary admin session confirmed that the
previously hidden bidder appears, is searchable, and opens both the management
dialog and detail page. No production account data was edited; that verification
session was signed out afterward. This release was deployed from the working tree.

Production is deployed at https://bidder-check.vercel.app and isolated Preview at https://bidder-check-staging.vercel.app. Production uses Supabase `aizorlyfggwbewetnwqm`; staging uses `kdmvludtvhuuewmhurpw`. Both have the application schema and private Storage. The designated account `david.chan.mdev@gmail.com` has been assigned the admin role.

The direct-account onboarding update is live. It replaces emailed bidder invitations with manager-created accounts (initial password `123456`), supports password changes in Settings, and signs clients in immediately after registration. SMTP is outside the revised scope. Production and staging have migrations 001–003, with all eight tables under RLS and a private file bucket.

## Review, interview reporting, and scheduled notifications

Migrations `202610050001`–`202610050003` add review-gated screenshot submission, interview tracking with retention-safe reporting, scheduled client messages, bidder inbox records, per-device push subscriptions, and atomic bulk review. The bid grid exposes the all-dates Pending review queue, per-column controls, and user-specific page size. `/interviews` reports first-application cohorts; `/notifications` manages schedules or the bidder inbox.

Notification delivery requires the separate SQL scripts under `supabase/scheduler/notifications-*.sql`. Configure `NOTIFICATION_WORKER_SECRET` in the matching Vercel environment, then create Vault secrets for that deployment's `/api/cron/notifications` URL and the same bearer value. On Vercel deployments protected by authentication, also store the deployment-protection bypass in that environment's Vault. Run the notification function script before its schedule script; the job invokes the worker every minute. Keep staging and production VAPID keys and push subscriptions separate.

Browser push is optional. Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in the matching Vercel environment; generate a pair with `npx web-push generate-vapid-keys`. Without these values, scheduled messages still publish to the in-app inbox. On iPhone/iPad, install Bidder Check to the home screen before enabling browser notifications. SMTP remains disabled.

Staging acceptance completed on 2026-10-05. The three migrations are applied to `kdmvludtvhuuewmhurpw`; Preview deployment `dpl_BoziLmFsTm2s9WYhDV6jFbFezApB` is READY at `https://bidder-check-lm3yco1wo-devtech06130324s-projects.vercel.app`. The staging notification Cron runs every minute, its Vault endpoint targets that deployment, and a worker invocation returned HTTP 200. The hosted suite passed all 20 checkpoints, including approval-gated screenshot upload, selected-recipient inbox delivery/read state, interview conversion, retention and reset cleanup; it removed its synthetic accounts and confirmed the cutover gate is off. Local lint, type checking, 87 unit tests, 41 database tests, and the production build pass.

Production migrations `202610050001` through `202610050003` were applied on 2026-10-05 through the authenticated Supabase CLI passwordless login flow; the production ledger matches local through `202610050003`. Production deployment `dpl_DfCtanwpjbKGLLkuaHySpyLn7Q5m` is READY at https://bidder-check.vercel.app. Scheduled in-app notifications are configured: `NOTIFICATION_WORKER_SECRET` is a sensitive Vercel Production variable, the endpoint URL, worker secret, and deployment-protection bypass are stored in Supabase Vault, and `bidder-check-notifications` runs every minute. Production worker verification returned HTTP 200 with no network error on 2026-10-05. Vercel deployment protection remains enabled. Browser push is optional; its VAPID keys are not configured, and real-device push was not exercised. These migrations are additive; do not run a production data reset.

## Required access

Use `.env.local` for local secrets; `.gitignore` excludes it. Keep secrets out of chat and Git.

| Setting                                | Purpose                                                              |
| -------------------------------------- | -------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase project URL (already provided locally)                      |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public client key (already provided locally)                         |
| `SUPABASE_SECRET_KEY`                  | Auth account creation and trusted screenshot verification            |
| `APP_URL`                              | Trusted application origin; localhost in development                 |
| `SUPABASE_ACCESS_TOKEN`                | Optional local deployment credential for Supabase Management API/CLI |
| `VERCEL_TOKEN`                         | Optional local deployment credential for Vercel CLI                  |
| `SUPABASE_DB_PASSWORD`                  | Temporary local-only CLI credential required for the production migration push; never add it to Vercel |
| `SUPABASE_DB_URL`                       | Exact staging Session Pooler connection URL in `.env.staging`; the staging push script verifies its project ref |

Management/deployment tokens are not runtime variables and must not be sent to browsers or installed in the Vercel application environment.

## Release order

1. Inspect migration history; apply checked-in migrations in order with `supabase db push`. Do not rerun the initial SQL over an existing schema.
2. Set `auth.email.enable_confirmations = false`. Keep SMTP disabled. Configure the environment's Site URL without overwriting unrelated provider settings.
3. Keep staging and production data isolated; apply and test migrations on staging first.
4. Import the GitHub repository into Vercel: Next.js, root `./`, Node `22.x`, `npm run build`, default output. Use `main` for production.
5. Add the four runtime environment variables separately to Production and Preview; previews use staging credentials.
6. Set the production `APP_URL` and Supabase Site URL to the assigned Vercel/custom domain; add `/auth/confirm` and `/auth/callback` to the redirect allowlist. Redeploy if environment variables changed.
7. Admin bootstrap is already complete. For another explicitly authorized administrator, register the account first, then run the bootstrap command with its email.
8. Run `scripts/hosted-smoke.mjs` against staging: immediate signup, direct bidder creation, initial-password login/change, two-client isolation, private downloads, invalid/valid screenshot uploads, correction/reapplication, retry idempotency and archival. The script cleans its synthetic users and files. Check deployment logs without logging profile/file contents.

Verification on 2026-09-29: 20 unit/database cases, 14 desktop/mobile browser cases, lint, typecheck and production build all passed. The full hosted Vercel staging journey passed all eight workflow checkpoints: immediate signup; bidder creation/default-password login/password change; private resumes; invalid screenshot rejection; valid evidence and earnings; direct HTTP tenant/storage permissions; correction/new-proof/retry behavior; earnings and archival. Synthetic accounts/files were cleaned up. Email delivery is intentionally not tested or required.

Application commit `ffd5474` reached READY in production (`dpl_4rJ8zXEdvLHPVYx72AkmES2sRcKF`) and staging (`dpl_Bc3FTUdih6hF46PtxXDyMiJUCeVS`). Subsequent documentation/test-runner commits may create equivalent deployments through the GitHub integration.

Post-release production checks passed: protected routes redirect to login, updated signup/recovery pages render on mobile without overflow, Supabase reports immediate signup enabled, and the designated administrator remains active. Production checks were read-only; complete data-mutation journeys ran on staging.

## Approval and bid workflow release ? 2026-09-30

The new application is verified on staging at commit `a247b2d`, deployment `dpl_9vdxHy9Du3yZXQaN56yXekLB8D9Y`. Migrations 004, 005, 006 and 202609300001 add client approval, account/email synchronization, atomic evidence application, recoverable trash and blocked-account settings restrictions. Earlier immediate-workspace onboarding is superseded: public client sessions now land on approval status until approved; SMTP remains unnecessary.

Release validation: 32 unit/database tests, 16 desktop/mobile browser tests, lint/type checking and production build passed. All 13 hosted staging checkpoints passed: pending/signup restrictions; rejection/approval; admin client create/archive/restore; synchronized email and confirmed password resets; bidder creation/login/password change; private resumes; invalid screenshot rejection; automatic application and replacement; direct tenant/storage restrictions; correction/reapplication/rate/idempotency; trash/restoration; parent archival/restoration; individual archival and retained earnings. Synthetic staging accounts/files were cleaned up.

Post-release verification uses `node --env-file=.env.local scripts/production-smoke.mjs`. It checks the designated admin without editing it, creates one synthetic pending client, verifies approval routing and password change, then removes exactly that generated account. No customer records are changed and no email is sent.

## Spreadsheet bid workflow - 2026-09-30

The spreadsheet application at commit `276bd13` is verified on staging, deployment `dpl_7k1uyA9Fx9FAbbfcfS888Htg5uhV`, and assigned to https://bidder-check-staging.vercel.app. It adds inline field editing, copy-only rectangular selection, mapped Sheets imports, and Yesterday (CT). Migrations `202609300002_spreadsheet_bids.sql` and `202609300003_url_canonicalization.sql` add version-checked mutations, actor-scoped import receipts, transactional import validation, and canonical duplicate keys. The normalization migration aborts on a historical collision instead of deleting records.

Release checks: 44 unit/database tests and 34 desktop/mobile browser checks passed, plus lint, type checking and production build. Coverage includes a 500-row preview and database transaction, Unicode/multiline clipboard values, conflicts, focus, filtered row removal, permissions, receipts, Chicago midnight and DST boundaries. The full hosted staging run passed 14 checkpoints, including an actual past-date Sheets import and inline edit, simultaneous edits, concurrent retries, and complete duplicate-batch rollback. Existing account, proof, earnings, trash and archive journeys also passed. All synthetic staging users/files were removed.

The test runner uses network-appropriate assertion timeouts. An initial staging run successfully imported/edited rows but used an incorrect accessible-name locator for the separate Saved status; that locator was corrected. A subsequent run hit a five-second upload-verification assertion while the upload was still completing; a 45-second network assertion limit resolved it. These were test-runner corrections; the final full run exited successfully.

Production smoke checks also verify that pending accounts cannot call the new spreadsheet RPCs or read import receipts. No SMTP configuration or new runtime environment variables are required.

Production release: commit `85a755b` reached READY at deployment `dpl_8QKRL5KLJ4MZ32EuLmjmtkLExKuK` on https://bidder-check.vercel.app. Both spreadsheet migrations applied successfully. Post-release production checks passed: designated admin remains active, public metadata cannot grant approval/roles, pending accounts cannot access workspace data or spreadsheet RPCs/receipts, and approval routing, password change and sign-out work. The synthetic production verification account was removed. Later documentation-only commits may create equivalent deployments through Git integration.

## Bulk controls and permanent trash deletion

Migration `202609300004_bulk_bid_controls.sql` adds actor-bound confirmation snapshots, version-checked bulk actions, durable screenshot cleanup, and SHA-256 import receipt fingerprints. Apply on staging before production; completed import retries never recreate purged rows. Selected operations are capped at 500; Empty trash uses the full authorized scope, with fixed-bidder pages remaining scoped.

Set a distinct server-only `CRON_SECRET` in Preview and Production. `vercel.json` schedules `/api/cron/storage-cleanup` daily at 05:00 UTC. Preview does not automatically run Vercel cron: exercise the route with the staging bearer secret. The worker processes at most 50 files per call, leases tasks for two minutes, retains failed tasks, and requires a second successful removal at least five minutes after the first. Application deletion is immediate; screenshot cleanup stays pending until verified. Managers can retry pending work in the app. Resume objects are never enqueued. Large backlogs drain across bounded manual/daily passes.

Hosted smoke tests create their own staging accounts and purge only those synthetic applications. They simulate an upload finishing after the initial delete, invoke authenticated cron, verify its physical object is removed, and clean their own operation/task records. Production smoke checks pending-account denial for the new RPCs without purging customer data.

Verified staging release: commit `9b5b27c`, deployment `dpl_8zJb28uuw7JzzWcZCEu4NYEfWZNs`. All 16 hosted checkpoints passed and generated accounts/files were removed. Local verification: 51 unit/database cases, 40 browser cases, lint/type checking and production build. A fresh review's pending-cleanup discovery issue was fixed with a failing-then-passing regression before staging.

Production release `161d372` reached READY as `dpl_6ABnUrWGAcXWpN8vYfY5XCv97spK` at https://bidder-check.vercel.app. Migration 202609300004 is applied in both environments. Post-release checks passed: designated admin remains active, signup metadata cannot grant privileges, pending accounts are denied all new bulk/purge RPCs, approval routing/password change/sign-out work, and unauthenticated cron requests return 401. The synthetic production verification account was removed; no existing customer records were purged. A smoke-test assertion was corrected to match denial messages case-insensitively before the successful rerun.

## Automatic screenshot cleanup scheduling

Migration `202609300005_cleanup_status.sql` is additive: `bid_purge_status` gains `serverTime`, `nextAttemptAt`, `processingFiles` and `awaitingRemovalFiles` (existing keys keep their meaning, except `failedFiles` now excludes tasks a worker currently holds), `retry_bid_cleanup` skips live leases, and `has_due_storage_cleanup()` lets the scheduler skip idle minutes. Deploy the app and migration together; older clients ignore the new keys.

The app polls status read-only. Cleanup itself no longer depends on an open browser: a Supabase Cron job runs every minute and calls the authenticated `/api/cron/storage-cleanup` endpoint through `pg_net` only when due, unleased tasks exist. The endpoint drains up to 20 batches of 50 files (or 40 seconds) per call. Leases (two minutes) make overlapping calls safe. The five-minute verification delay is unchanged, so a removed screenshot completes within about a minute after it becomes eligible. The daily Vercel cron stays as a backup.

Per environment (staging first), as the project owner, outside `supabase db push`:

1. Create the Vault secrets listed in `supabase/scheduler/storage-cleanup-schedule.sql`: the environment's endpoint URL, its `CRON_SECRET`, and on staging the deployment-protection bypass.
2. Run `supabase/scheduler/storage-cleanup-function.sql`, then `supabase/scheduler/storage-cleanup-schedule.sql`. Both are idempotent.
3. Monitor with the queries at the end of the schedule file (`cron.job_run_details`, `net._http_response`). Worker logs contain counts only, never file paths.

Staging acceptance: `SMOKE_VERCEL_BYPASS=<automation bypass> node --env-file=.env.staging scripts/cleanup-schedule-acceptance.mjs`. With no browser open, it purges 61 synthetic applications with real screenshot objects through the database RPCs. It simulates an upload landing after the first removal, then waits for the scheduler alone; it never advances timestamps or calls the worker. It asserts the unauthorized 401, first removal within about two minutes, the five-minute verification wait and removal of every object, then deletes its synthetic accounts and files. For production, deploy the same way and confirm the existing pending operation completes through its queued task; do not create another purge or mark work complete by hand.

`CRON_SECRET` is a Vercel _sensitive_ variable, so `vercel env pull` returns a placeholder, not the value. Take the Vault value from the operator's secure record (`.env.local` for production, `.env.staging` for staging). A mismatch shows as HTTP 401 rows in `net._http_response`.

Release 2026-10-01: commit `602c190`, production deployment `dpl_3dWRXZFmTN6R8yJ31tgzfgh9PamM`; staging preview `dpl_GjkvcPuutFTgcXZyMZBdyQQK1AA4`. Migration 202609300005 is applied in both environments, and both have the `storage-cleanup` Supabase Cron job (every minute) with Vault secrets.

Verification:

- Local: 77 unit/database tests, browser tests (one pre-existing intermittent spreadsheet-focus case unrelated to this change), lint, type checking and production build.
- Staging real-delay acceptance: 61 files removed by the scheduler in 32s, including a late upload, and verified 391s after deletion. No browser was open and no manual worker call was made.
- Staging hosted smoke: all 16 checkpoints passed.
- Production: the one existing pending task from the 2026-09-30 8:04:13 PM CT purge completed through its queued task at 12:07:01 AM CT, on the first scheduled call after the secret correction. No unfinished tasks remain. No purge was created and nothing was marked complete by hand.
- Production smoke checks passed, and its synthetic account was removed.

## Shared profiles, bid restrictions, retention, and legacy-library reset

Migrations `202610040001`–`202610040009` add shared candidate profiles, bidder-specific resume assignments, profile-wide bid restrictions and retention aggregates, a checked reset inventory, and a temporary write gate for the cutover. Keep `.env.staging` pointed at the isolated staging project. The staging hosted smoke uses only synthetic accounts and performs a scoped reset of its synthetic workspace; it verifies both immediate Storage removal and the delayed second pass. Never point that smoke script at production.

The production cutover tool is intentionally guarded and does not print account addresses or file paths. After applying the schema and deploying the production app, take an inventory with:

```powershell
.\node_modules\node\bin\node.exe --env-file=.env.local scripts/application-library-cutover.mjs --environment=production --inventory
```

The command reports counts and an inventory fingerprint covering all workspaces, workspace settings, application-library rows, aggregates, and workspace-scoped private Storage paths. The authorized reset requires that exact fingerprint and the fixed confirmation phrase; it briefly pauses library writes, rechecks the inventory while locked, removes only candidate profiles/assignments/applications/history/aggregates, preserves accounts/workspaces/memberships, resumes writes after the empty-state check, and waits for cleanup of the captured old Storage paths:

```powershell
.\node_modules\node\bin\node.exe --env-file=.env.local scripts/application-library-cutover.mjs --environment=production --reset --expected-fingerprint=<inventory-fingerprint> "--confirm-reset=RESET ALL APPLICATION LIBRARY DATA"
```

The production cleanup origin defaults to `https://bidder-check.vercel.app`, so a local-development `APP_URL=http://localhost:3000` cannot redirect the cutover worker to localhost. Set `CUTOVER_APP_URL` or pass `--app-url=https://<production-domain>` only when the deployed production domain changes. The script refuses a changed inventory, a different Supabase project, a missing active admin, or a missing `CRON_SECRET`. If database deletion succeeds but Storage verification is still pending, resume without repeating the reset:

```powershell
.\node_modules\node\bin\node.exe --env-file=.env.local scripts/application-library-cutover.mjs --environment=production --verify-cleanup
```

Release 2026-10-04: migrations `202610040001`–`202610040009` applied to production. Deployment `dpl_9p1e6z4Fxwd5u6DTGmMWVZFPSXXy` published the shared-profile workflow; deployment `dpl_Ew8mM5XtMmB5RZKRMc8AJbCpAggy` added cleanup failure-phase logging. The authorized reset removed 2 shared profiles, 2 assignments, and 2 resume PDFs from 2 workspaces; there were no bids or earnings. It preserved all 3 accounts, both workspaces, and the bidder membership. The write gate is off, the application library is empty, all queued Storage verification tasks completed, and the production cleanup endpoint returned HTTP 200. A first local cleanup-tool attempt used the development `APP_URL`; the database reset remained successful, and the production scheduled worker completed the delayed verification. The tool now targets the deployed domain and supports cleanup-only recovery.

## Production admin-only reset

On 2026-10-05, the requested Production reset superseded the earlier reset state above. It preserved only the active Auth account and profile for `david.chan.mdev@gmail.com`; it removed the other 3 Auth users, 2 workspaces, 1 bidder membership, and all other application rows. Before the reset there were no bids, resumes, shared candidate profiles, file records, or Storage objects. The completed cleanup tasks and prior application reset audit were also cleared. Post-reset verification found exactly 1 Auth user and 1 active admin profile, with no workspaces, bidders, applications, resumes, files, messages, inbox notifications, or Storage objects. The application-library write gate is off. Production Cron, Vault secrets, Storage bucket configuration, schema, and migration history were retained; every local migration through `202610050003` is applied.

## Screenshot paste, detailed reporting, and reviewed batch imports

Migrations `202610060001_reliable_reviewed_imports.sql` and `202610060002_dashboard_reporting.sql` add the optimized reviewed-row import RPC and the scoped CT performance-report RPC. Deploy both migrations before the app. No new environment variables are required.

Staging verification should run `node --env-file=.env.staging scripts/hosted-smoke.mjs` against the isolated staging project. The smoke seeds 10,000 synthetic applications, measures transactional 476- and 500-row imports through the authenticated Supabase RPC, and removes its test accounts, workspaces, applications, and files. It paginates cleanup reads and deletes bid history in bounded batches. If a run is interrupted, take its UUID prefix from the synthetic account email and run `$env:SMOKE_PREFIX='smoke-<uuid>'; node --env-file=.env.staging scripts/cleanup-hosted-smoke.mjs`. Both scripts refuse any project except staging; never run them against Production.

The report uses CT date buckets, combines live applications with retention aggregates, and scopes all groupings through database authorization. The spreadsheet importer submits only the reviewed allowed subset, records source-row skips in its result, and stores only a payload fingerprint plus minimal receipt metadata. Statement timeout (`57014`) is reported as a retryable no-commit error.
