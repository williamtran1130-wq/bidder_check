# Reliable reporting rollout

Deploy the compatibility database changes, then the compatible app, then financial enforcement. Do not run a normal `supabase db push` from the complete repository before the app deploy: it applies every pending migration, including enforcement. The supported workdir/dry-run procedure below creates an explicit compatibility artifact. [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-db-push).

## Phases and gates

| Phase | Included migration versions | Result | Gate before continuing |
| --- | --- | --- | --- |
| Compatibility database | `202610120001` reporting v2, `202610120002` financial reads, `202610120003` quiet imports | Adds reporting endpoints, manager financial helper and safe `list_bids_v2`. Legacy `list_bids` keeps its original money-bearing row shape for the currently deployed manager app. Existing stored rates/write history remain intact. | Review dry-run: only these three new versions are pending. Confirm old app lists still load and new RPCs exist. |
| Application | Compatible build of this change | Uses safe bidder/resume projections, `list_bids_v2`, manager-only financial overlays, reporting v2, readonly import preview, and bidder financial hiding. | Verify manager/bidder lists, assignments, counts, editing, conflicts, uploads, interviews and imports. Retain this build as the post-enforcement rollback target. |
| Enforcement database | `202610120004` | Revokes direct money/event-detail reads; safely replaces legacy `list_bids` with an invoker wrapper to v2; makes legacy money reports manager-only. | Review dry-run: only version 004 pending; confirm compatible app is deployed on every instance before apply. Verify denied bidder money and working safe operations after apply. |

The migration filenames in the release are:

- `202610120001_reporting_v2.sql`
- `202610120002_financial_reads.sql`
- `202610120003_quiet_bid_imports.sql`
- `202610120004_financial_enforcement.sql`

## Concrete PowerShell procedure

Run from a reviewed release checkout with no migrations after version004. The target must already have the baseline migrations through `202610070001`. Use the installed project's pinned CLI through `npx.cmd`; supply credentials using the CLI prompt or approved environment mechanism. The October 12 release follows this procedure after the user's deployment authorization; its completed environment checks are recorded in [the deployment log](deployment.md).

Create an isolated compatibility workdir containing baseline plus only versions001–003. The `<=` filename cutoff deliberately excludes version004 and any subsequent migrations. The source checkout remains complete and unchanged.

```powershell
$releaseRoot = (Resolve-Path .).Path
$compatStage = Join-Path $env:TEMP ("bidder-check-compatible-" + [guid]::NewGuid())
$stageMigrations = Join-Path $compatStage "supabase/migrations"
New-Item -ItemType Directory -Path $stageMigrations -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $releaseRoot "supabase/config.toml") -Destination (Join-Path $compatStage "supabase/config.toml")
Get-ChildItem -LiteralPath (Join-Path $releaseRoot "supabase/migrations") -Filter "*.sql" |
  Where-Object { $_.Name -le "202610120003_quiet_bid_imports.sql" } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stageMigrations }
if (Test-Path -LiteralPath (Join-Path $stageMigrations "202610120004_financial_enforcement.sql")) {
  throw "Enforcement must be absent from the compatibility artifact"
}
Get-ChildItem -LiteralPath $stageMigrations | Select-Object Name
npx.cmd supabase link --project-ref YOUR_REVIEWED_PROJECT_REF --workdir $compatStage
npx.cmd supabase migration list --linked --workdir $compatStage
npx.cmd supabase db push --linked --dry-run --workdir $compatStage
```

Review the target project reference and the dry-run output. It must show exactly pending `202610120001`, `202610120002`, and `202610120003`, with version004 absent. If the target history differs, resolve it before proceeding; do not use history repair to pretend a migration ran. Then apply this reviewed compatibility artifact:

```powershell
npx.cmd supabase db push --linked --workdir $compatStage
```

Deploy the compatible application and perform the application gate above. Keep the compatibility artifact unchanged. Only then add the single enforcement file to that same linked staging workdir:

```powershell
Copy-Item -LiteralPath (Join-Path $releaseRoot "supabase/migrations/202610120004_financial_enforcement.sql") -Destination $stageMigrations
npx.cmd supabase migration list --linked --workdir $compatStage
npx.cmd supabase db push --linked --dry-run --workdir $compatStage
```

The second dry-run must show only version 004 pending. Apply it after confirming all application instances use the compatible reads:

```powershell
npx.cmd supabase db push --linked --workdir $compatStage
```

Do not add `--include-all`, `--include-seed`, `--include-roles`, or automatic yes flags to bypass this review. `db push` consults remote migration history and skips already applied versions; `--dry-run` lists proposed migrations without applying them. `--workdir` and `link --project-ref` are documented CLI options. [Supabase CLI flags and link](https://supabase.com/docs/reference/cli/supabase-link).

## Rollback and API behavior

Before version004, an application rollback can use the existing legacy list shape. After version004, roll back only to an application build that retains safe projections, the `list_bids_v2` endpoint, optional financial DTO fields, and manager financial overlays. The pre-change build selects full financial rows and is incompatible with enforced column privileges. Retain the compatible read build even if rolling back an unrelated feature. Keep version004's privilege restrictions and guards in place; an application rollback is not a reason to regrant financial columns.

After enforcement, authenticated callers cannot directly select, filter, order or embed `bidders.default_rate_cents`, `resumes.rate_override_cents`, `bids.rate_cents`, retained `earned_cents`, or `bid_events.details`. Wildcard projections over those tables fail; request explicit safe columns instead. Safe list/count/history and write procedures retain RLS. Service-role direct access remains available. Invitations remain manager-scoped by RLS.

`list_bids_v2` and the final legacy `list_bids` wrapper are SECURITY INVOKER, require authenticated EXECUTE, and deny PUBLIC/anon execution. Manager amounts come from `manager_financial_values` using auth.uid plus active/approved manager checks and `manages(workspace_id)` for every requested row. It rejects any missing/foreign/null identity or unauthorized mixed batch. Total identities per request are capped at 1000; the server helper deduplicates identities and chunks the combined bidder/resume/bid requests. Zero and null remain distinct. It never runs for bidder workspace loads.

Legacy `dashboard_performance`, `earnings_performance`, and `retained_aggregate_summary` reject bidders, archived users, and unapproved callers after enforcement. Use `dashboard_performance_v2` for role-aware money-free bidder dashboards, `earnings_performance_v2` for managers, and `interview_performance` for interviews without monetary fields.

## Local verification

```powershell
npx.cmd vitest run tests/financial-rollout.test.ts tests/financial-boundary.test.ts tests/financial-data.test.ts tests/workspace-loader.test.ts tests/database.test.ts
npx.cmd tsc --noEmit
```

Rollout tests execute a real local PGlite database with migrations only through 002 and prove the original manager list shape still includes rate while v2 omits rate. Final role tests load all migrations and assert invoker/EXECUTE privileges, RLS tenant isolation, denied direct money/wildcard/predicate/order/embedded/history access, legacy money guards, manager zero/null/override reads, unauthorized and inactive caller rejection, request limits, service access and intact stored audit snapshots. Safe editing and resubmission succeed with rates omitted from bidder conflict/success JSON. Loader tests cover more than 1000 assignments, per-page bidder filtering, first/additional assignable profiles with workspace scope, and combined financial batches. Existing 52 database scenarios preserve financial snapshots and application/retention/write invariants through the new authorized reads.

These local tests do not prove hosted PostgREST schema-cache refresh, production query latency, or the target's deployed application version. Complete those environment gates during deployment. The hosted smoke script uses manager overlays and bidder denial and creates and cleans up synthetic staging accounts/data. Consult the deployment log for executed hosted checks.

The integrated local verification on October 12, 2026 passed 175 unit/database tests, 120 distinct desktop/mobile Playwright cases, typecheck, ESLint and the production build. Browser coverage includes accessibility, valid custom-date drafts, CT midnight refresh, edit/search deferral, request races, failed-filter result isolation, bidder financial hiding, status-only imports and exact uncertain-response retries. These fixture browser checks complement the authenticated-role PGlite tests; they do not claim the hosted acceptance benchmark has passed. See [hosted diagnostic evidence and the performance release gate](reporting-performance.md).
