# Overview comparisons, shorter navigation, and workspace names

Approved implementation plan, 2026-10-12. Use Superpowers subagent-driven-development and independent review. Existing Product Design styles and selected split-bar design are the visual target.

## Global constraints

- Remote versus Onsite/hybrid appears in the existing By bidder and By profile cards, with paired Found and Applied stacked bars. Older unclassified retained data is Unspecified, never guessed.
- Applied means currently applied from the same found-date CT cohort. Current live arrangement; arrangement at cleanup for retained records. Preserve original totals, financial restrictions, readable scope, indexed bounds, and compressed aggregation.
- Rank top ten by applied count, found count, stable ID. Expandable exact values include every group, arrangement counts, totals and completion. Bidder sees own profiles; managers additionally see bidder comparisons.
- Sidebar: Bid workspace -> Bids; Resume library -> Resumes; Candidate profiles -> Profiles; Interview performance -> Interviews. Other labels, routes, page headings and permissions remain.
- Default workspace format: Workspace - {owner display_name}. Replace ALL existing names including custom and admin-owned workspaces. Keep later workspace name edits independent from profile edits.
- Existing defaults stay Overview this_week, Bids today, Earnings this_week, Interviews all. New forward migrations only; no historical migration edits. No secrets in source/logs.
- Tests, staging then production rollout are authorized. Read installed Next.js documentation before app changes. Parent coordinates commits and release.

## Task 1: Reporting and retention

Own only supabase/migrations/202610120006_arrangement_reporting.sql, tests/reporting-v2.test.ts and a new tests/arrangement-retention.test.ts as needed. Do not edit generated types or other files without coordinating.

Extend dashboard_performance_v2 JSON additively: each comparison has arrangements = {remote, onsiteHybrid, unspecified}, each value {found, foundApplied}. Original fields/signature retained. A new private dashboard event helper preserves scoped indexed compressed event branches; shared private.report_events and financial/interview callers remain intact. Revoke direct helper execution from PUBLIC/anon/authenticated. No extra browser requests.

Add bigint remote_count, onsite_count, hybrid_count >=0 defaults0 to retained aggregates, known sum<=record_count. Existing counts become unspecified. Update process_candidate_retention to select arrangement and atomically increment found aggregate counters before deletion. Preserve existing cleanup/locking/limits/security. Missing old breakdown is unavailable in UI, not zero (Task3).

Use TDD for reporting/retention. Cover mixed work types/unapplied bids; arrangement edits; same profile across assignments; duplicate names; CT boundaries; trash; permissions; legacy unspecified plus new known merging same PK; cleanup idempotence and before/after reconciliation. Point generic-plan/index-bound/compression tests at new helper too. Run focused tests and self-review. Parent owns full suite and commits. Report command/results and red/green evidence.

## Task 2: Workspace names

Own only supabase/migrations/202610120007_workspace_display_names.sql and new tests/workspace-names.test.ts. UI fallback owned by Task3.

Name source authoritative owner profiles.display_name (not auth metadata), trimmed including tabs/newlines; fallback email local-part then Client. Entire generated name max100 characters (prefix12, owner part88). BEFORE INSERT trigger fills omitted/null/blank/legacy My workspace, removes static default, preserves explicitly supplied custom names. Auth provisioning function unchanged. No synchronization of later profile/admin edits.

Forward migration replaces every existing name including custom/client/admin/pending/archived, preserving all other fields. In same locked transaction, store workspace ID, old name and generated name in access-restricted private rollback table. Rollback routine/script restores only rows whose current name equals recorded new name. Keep backup outside public/authenticated access; no unsafe grants. Decide SQL helper/rollback implementation minimally, document manual invocation. Do not execute against hosted databases.

TDD with staged old-schema->new-migration backfill (see financial-rollout tests). Cover signup/trusted provision, omitted/null/blank/legacy/explicit custom, Unicode/100limit, fallback, replace every old name, rollback skipping later renames, independent Settings/update_client edits, memberships/settings and permission preservation. Focused tests/self-review; parent commits.

## Task 3: Overview UI and navigation

Own src/components/dashboard.tsx (extract comparison component if beneficial), src/lib/report-types.ts, src/components/shell.tsx, src/app/(workspace)/layout.tsx, tests/preview/actions.ts, e2e/reporting.spec.ts, and UI-specific new test files. Coordinate other e2e selector fixes with parent. Do not edit generated database types or migrations.

Add optional arrangements to ComparisonRow so mixed-version absence can display Breakdown unavailable without made-up zero counts. Shape fixed by Task1. Split bars: two clearly labeled horizontal bars per entity, Found and Applied, each stacked Remote/Onsite-hybrid/Unspecified. Distinct legend with theme-appropriate colors, gray Unspecified only when present. Explain old history briefly. Exact values and completion percentages in accessible expandable table for every row. Retain top10 sorting, manager/bidder visibility, period/filter/loading/empty/error behavior and activity chart. Responsive row-count-based chart height; side by side desktop/stacked mobile; no extra panels. No hover-only information.

Use existing design styling. Rename sidebar/breadcrumb labels to Bids/Resumes/Profiles/Interviews. Wrap long full workspace name expanded/mobile; full name via keyboard-accessible tooltip when collapsed. Fallback Workspace (never infer owner from signed-in bidder). Preserve page headings/routes/roles.

Read node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md. TDD for meaningful chart behaviors; preview fixtures include true known arrangements and absent breakdown cases. Browser checks mixed/unknown/unavailable/empty, roles, exact reconciliation, mobile/desktop, ten groups and long names. Existing authorized browser suites may be run. Use isolated fixture server port if necessary; report red/green results, self-review, no commits.

## Task 4: Integration, review and release

Parent regenerates database types, adapts hosted acceptance/benchmark and fixtures, docs. Independent task and final branch reviews. Typecheck, lint, all unit/database tests, production build, relevant browser suites. Verify screenshots in desktop/mobile light/dark and keyboard access.

Use existing scripts with verified targets. Benchmark before/after authenticated staging with five readers and representative twice-production rows, p95<2s/no timeouts. Deploy migrations before app, staging first; verify reporting, names, access and fixture cleanup. Then production migration and application, exact commit/alias and read-only smoke. No fabricated success on failed reads. Capture deployment and protected rollback evidence, preserve original .env files, clean task fixtures.
