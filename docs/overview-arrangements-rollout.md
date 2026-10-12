# Overview arrangements and workspace naming rollout

Apply after the existing reporting/financial cutover and migration `202610120005`.

1. Verify all local checks and independent code review, then run the staging benchmark before migration: `node --env-file=.env.staging scripts/reporting-staging-benchmark.mjs --staging-ready`. It seeds and cleans 25,000 isolated bids with five concurrent authenticated readers. Preserve the receipt before the next run.
2. Dry-run the linked staging migration push; require only `202610120006` and `202610120007`. Apply them before deploying the application. Migration006 adds arrangement counters and an additive dashboard response; old application builds remain compatible. Migration007 replaces **all** existing workspace names, including custom names, using the owner's authoritative display name.
3. Verify the workspace replacement and restricted backup, then run the benchmark again with `--arrangements`. It checks exact split counts, legacy unspecified history, totals, role restrictions, the p95-under-two-seconds gate and fixture cleanup.
4. Deploy the reviewed application to Preview/staging. Run `scripts/reporting-production-smoke.mjs --staging-read-only --arrangements` with staging environment variables and the configured protection bypass. Check mobile/desktop and light/dark screenshots, keyboard navigation, long names, and exact values.
5. After staging passes, dry-run and apply the same migrations to the verified production project; deploy the same tested application commit using Production environment variables. Confirm the production alias and run `scripts/reporting-production-smoke.mjs --production-read-only --arrangements` with production environment variables. The smoke uses isolated no-email sessions for existing actors and performs no customer/application data writes.

Do not change the user's environment files, print credentials or private workspace names, or mix Preview and Production environment configuration. Keep migration and deployment receipts separate from source control. Preserve the existing calendar defaults and financial column restrictions.

## Name replacement and recovery

The naming migration captures old/generated names in `private.workspace_display_names_202610120007` and replaces names in the same locked transaction. The table and helper functions are inaccessible to application roles, including service_role. The migration includes every workspace, including pending/archived owners and owners later promoted to admin.

If name data must be rolled back, connect as the database owner and run:

```sql
select private.rollback_workspace_display_names_202610120007();
```

The returned count includes only workspaces whose current name still equals the recorded migrated name. Later custom renames and newly created workspaces are left intact. This data rollback keeps automatic insert naming enabled. Keep the restricted backup until the release is accepted; never export it into public or committed artifacts.

Rolling back the application does not require removing additive counters or report fields. Missing arrangement payloads render as unavailable; historical unspecified counts are never fabricated as Remote or Onsite/hybrid.
