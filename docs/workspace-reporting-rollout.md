# Workspace reporting and latest application location

This release changes both bidder-check and mail-check. All verification so far is
local. No hosted migrations, scheduler changes, deployment, or billing settings
have been applied by the implementation session.

## Release sequence

Use a coordinated release window. Do not run all migrations against the old
application and leave it running: migrations 002 and 003 intentionally retire
the old upload-history and notification RPCs.

1. Apply `202610310001_workspace_report_storage.sql` first. It backfills live
   daily summaries and normalized mail storage. Existing non-notification report
   RPCs retain their response shapes. Version 1 publishers remain accepted.
2. Run `supabase/maintenance/workspace-reporting-check.sql` as the database owner.
   Require zero differing rows. Compare authorized client/admin/bidder reports
   and retained totals before continuing.
3. Deploy the new bidder-check application, then immediately apply
   `202610310002_latest_application_location.sql` and
   `202610310003_retire_notifications.sql` in order during the release window.
   Until 002 is installed, older list results have no inline location or country
   filtering; do not accept country-filtered results during that interval.
4. Verify role-restricted reports, applied locations, country filtering, People
   approval, a new verified upload, and screenshot expiry behavior. Old IP
   history and notification records are permanently removed by these migrations.
5. Remove notification-only Vercel environment settings and any external
   notification schedules. Migration 003 removes the known database cron job
   and notification Vault entries, but cannot control external schedulers.
   Keep storage cleanup and its secrets.
6. Update mail-check using its existing release/package process. Its publisher
   negotiates v2 from `snapshot_versions`, retains v1 fallback, and discovers an
   upgraded server when pending work exists. No user re-login is required solely
   for the protocol upgrade. Verify one full upload, then a metadata-only delta.

Do not apply hosted migrations from a Vercel build. Keep any database backup
required by the deployment operator's ordinary release process before the
intentional deletions. A pre-migration application is not a complete rollback
after migrations 002/003 because its notification/history endpoints are retired.

## Reporting rollback and repair

The old raw-bid reader is retained. As the database owner:

```sql
update private.reporting_rollout set use_summaries = false where singleton;
```

This changes report reads; summary maintenance continues transactionally. After
investigation, run the explicit repair script
`supabase/maintenance/workspace-reporting-rebuild.sql`, require zero reconciliation
differences, then set `use_summaries = true`. Rebuilding serializes bid writers
briefly, and must be scheduled accordingly. It does not alter bids, saved rates,
retained history, or mail classifications.

The summary key follows assignment identity; current profile names, mailbox
assignments and permissions are resolved on each read. Retained aggregates are
read alongside live counters, not copied into the live rollup.

## Acceptance and usage measurements

Run local checks:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test -- --maxWorkers=2
npm.cmd run build
node node_modules/@playwright/test/cli.js test --config tests/preview/workspace.playwright.config.ts
node scripts/workspace-reporting-benchmark.mjs
```

The browser config starts or reuses a local Next production server on port 3005
and the isolated fixture app on 3001. It does not sign in to hosted accounts or
send mail. Do not rebuild `.next` while that production test server is running.
In restricted Windows environments, starting these two servers separately avoids
Playwright process-tree teardown stalls; stop only the processes started for this
run when finished.

The local benchmark is synthetic PGlite, with 22,456 primary bids plus 120 other
fixture bids. It compares authorized report outputs, five queued requests per
burst, versioned edit RPC timing, and summary reconciliation. It is **not** proof
of five independent hosted PostgreSQL connections or Vercel CPU savings. Its
evidence includes the slower raw UPDATE microbenchmark separately from the
representative authenticated mutation; do not hide that trigger-maintenance cost.

Before hosted performance acceptance, repeat representative cold/warm bounded and
All time reads with five independent connections at twice the current observed
production volume. Require p95 under two seconds, no timeouts, and no more than
20% regression in representative write latency. Use matching roles, data and
filters for before/after measurements.

For seven days after deployment, record measurement time, billing period, project,
deployment identifier, and cumulative values for:

- Vercel function invocations, active CPU, provisioned memory, CDN requests, origin
  transfer and fast data transfer.
- Supabase database/Auth/Storage egress, cached egress, storage bytes and log ingest.
- Application errors, slow reads, report refresh counts, and publisher full/delta
  payload bytes. Do not record private payloads, IP addresses or mailbox contents
  in diagnostics.

Use daily increments within the same billing cycle, normalize against active
users and work volume, and start a new series at a cycle reset. Existing cumulative
usage cannot be reduced retroactively. Provider totals in the supplied screenshots
do not identify individual routes or prove that all usage belongs to this app.

Meter references: [Vercel usage](https://vercel.com/docs/pricing/manage-and-optimize-usage),
[Supabase egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress),
[Supabase logs](https://supabase.com/docs/guides/platform/manage-your-usage/logs).
