# Screenshot size sorting and matching badges

User-approved implementation plan, 2026-10-12. Implement with Superpowers subagent-driven-development and Product Design grounded in the existing Bids table. Parent owns integration, commits, staging and production rollout.

## Global Constraints

- Compare exact file sizes in bytes. Compact KB/MB badges appear beside screenshots only for clients/admins, in Bids and embedded bidder activity.
- Color only sizes repeated across the entire current filtered result, including other pages. Count includes the displayed screenshot. Admin counts include all authorized results currently in view.
- Derive stable colors from raw bytes using a fixed accessible light/dark palette. Labels are authoritative when colors repeat. Equal file size is a review aid, not proof of identical image content.
- Keep the Screenshot column, existing screenshot-presence sorting/filtering, current period defaults and bidder interface. Add Size: smallest first / largest first to its header menu.
- Badge popover is keyboard/touch accessible and shows exact bytes and count. Unique sizes are neutral; no attached screenshot means no badge; attached but unavailable metadata means Size unavailable.
- Optional BidRow transport fields are screenshot_size_bytes?: number | null and screenshot_size_match_count?: number. Manager no-valid-evidence values are null/0; unique bytes/1; repeated bytes/2+. Bidder JSON omits both.
- Global numeric size sorting happens before pagination, NULLS LAST both ways, then found_at DESC, id ASC. Unauthorized bidder size sorting follows existing unsupported-sort fallback behavior.
- Current finalized evidence only, matching bid/workspace/bidder IDs. Preserve SECURITY INVOKER, RLS, explicit safe bid projections, financial restrictions and existing file/upload permissions. No backfill/image downloads.
- Counts belong to the loaded query snapshot. Refresh after mutations affecting evidence or result membership using existing editing deferral; never compute matches from the current page alone.
- New forward migration only. Tests, independent review, staging then production rollout are authorized. Never print secrets or modify original environment files. Read installed Next.js docs before app changes.

## Task 1: Scoped screenshot size query

Own supabase/migrations/202610120008_screenshot_size_matching.sql, new tests/screenshot-size-query.test.ts, and the diagnostic sort allowlist in src/app/(workspace)/actions.ts. Coordinate before editing any other file. No Git commits or hosted writes; parent owns them.

Extend list_bids_v2(p_query jsonb) additively. Retain all existing filters/counts/sources, the signature, grants, invoker mode and safe JSON bid projection. Gate metadata once on an active approved client/admin profile. Treat screenshot_size_bytes as supported only for that capability.

Add workspace_id to the safe internal filtered projection. From status_filtered create one materialized current_evidence_sizes set joining public.files by current evidence_file_id plus matching bid_id/workspace_id/bidder_id, kind screenshot and finalized true; gated off for bidders. Group that materialized set by size_bytes with count(*)::integer. Reuse it for global sorting and page metadata in the same request/snapshot. Do not count outside status_filtered, historical files, unfinalized files or inaccessible scopes. Leave statusCounts aggregation before selected status unchanged.

Use TDD. Database tests must execute real SQL under authenticated client/admin/bidder roles: numeric ordering across pages in both directions, exact-byte ties vs rounded-display equality, nulls last and deterministic ties; counts across pages under ordinary sorting; counterpart excluded by period/status/search/column/bidder/profile/trash; admin multi-workspace counts and client tenant isolation; mismatched/incomplete evidence; replacement files and historical files; omitted bidder metadata/unsupported sort; anonymous denial; financial boundaries. Exercise realistic manager datasets with finalized screenshots and inspect query-plan/performance concerns. No speculative policy/index rewrites without evidence; escalate measured bottlenecks to parent. Run focused tests, self-review, write a report with RED/GREEN commands and output.

## Task 2: Size badge, sorting and refresh integration

Own src/lib/workspace-types.ts, src/components/bids.tsx, src/components/screenshot-cell.tsx, src/components/bid-grid.tsx only if header aria-sort integration requires it, new focused screenshot-size helper/component files and tests, tests/preview/actions.ts, tests/preview/sample-data.ts, tests/preview/main.tsx, and new e2e/screenshot-sizes.spec.ts. No other files without coordinating. No Git commits or hosted writes.

Read installed Next.js guide node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md. Use existing shadcn/Radix patterns and typography; no new column or row tint. Add optional BidRow fields from Global Constraints; do not change database storage Row<"bids"> or SAFE_BID_COLUMNS for derived values.

Show compact KB/MB badges beside screenshots. Use a deterministic fixed light/dark palette keyed by exact integer bytes, colored only for count>=2; neutral for1. Badge popover displays exact bytes and inclusive matching count, explains matching file size does not prove identical content. Keyboard and tap work; screen-reader labels include numeric meaning. Missing fields are unavailable, not zero or unique. Managers only, including when preview/data accidentally contains metadata for bidders.

Add explicit Size: smallest first / Size: largest first controls to the Screenshot header's existing popover; set manual sort ID screenshot_size_bytes and indicate selected order accessibly. Preserve current presence sort/filter, edit-lock disabling and selection/pagination resets.

Reload the server list snapshot after screenshot upload/replacement, inline edit/conflict resolution, trash/restore/review and other mutations affecting membership. Preserve existing deferral during active editing/upload. Inline update currently replaces whole rows in bids.tsx; avoid losing metadata or preserving stale group counts indefinitely. Use established revision/refresh machinery rather than per-page counts or an extra metadata request.

TDD for meaningful formatting/group/role behavior and browser scenarios. Preview fixtures must reproduce full filtered-set exact counts, numeric global sorting, null/tie behavior and metadata changes after mutations. Cover matching off-page counterpart, differing bytes with same displayed KB, unique/missing/unavailable, repeat colors across sorting/pages, client/admin/bidder and embedded view, keyboard/touch, light/dark and desktop/mobile; verify filters change count, editing and replacement refresh badges. Use isolated preview port/config in task artifacts when needed to avoid conflicts with parent full suites. No screenshot-specific objects fabricated in production. Focused tests and screenshots; self-review and report RED/GREEN evidence.

## Task 3: Hosted verification tools and rollout documentation

Own a new scripts/screenshot-size-staging-benchmark.mjs, changes to scripts/reporting-production-smoke.mjs gated behind --screenshot-sizes, and new docs/screenshot-size-rollout.md. Do not modify existing unrelated benchmarks. No Git commits, hosted mutations or benchmark execution; parent executes guarded scripts after review.

Build on existing scripts/reporting-staging-benchmark.mjs and scripts/reporting-production-smoke.mjs safety patterns. Stage benchmark must require exact dedicated staging Supabase target and explicit --staging-ready; use isolated uniquely marked synthetic users/workspaces/bids/files, never customer scopes; persist cleanup receipt before writes. Seed at least25000bids with representative finalized screenshot metadata, repeated byte groups, null/missing/manual and unfinalized/historical examples. Actual storage upload not needed for metadata benchmarking. Use real authenticated client/admin/bidder sessions, five concurrent readers, at least25samples for ordinary/ascending-size/descending-size sorts, full/restricted ranges. Verify exact counts and ordering independently, bidder omission/role boundaries, p95<2000ms and no statement timeouts. Baseline mode before migration may measure ordinary sorts only; after mode verifies new feature. Cleanup scoped files/evidence FK order safely and verify zero residual test data; support guarded recovery after partial cleanup. Never print credentials or production names.

Production smoke --screenshot-sizes is additive and read-only for customer/application data, using existing no-email scoped sessions. Verify RPC shape/counts/order where data allows, manager header controls/badges, bidder absence, exact-byte popover/role gating and current defaults. Absence of duplicate production data is legitimate, never mutate customers to force it. Preserve existing guardrails and checks. Document migrations-first compatibility, staging benchmark/fixture cleanup and staged production deployment at exact tested SHA. Task scope may include isolated unit tests for pure fixture validation/cleanup guards if needed, not implementation-mirroring tests. Syntax-check and focused verification; full report/self-review.

## Task 4: Parent integration, independent review and release

Create isolated worktree, baseline checks and task ledger. Independent task reviews and final whole-branch review. Regenerate types only if public schema signature change requires it (RPC remains JSON with same signature). Full lint/typecheck/unit/database/build/browser suites; compare desktop/mobile light/dark against current table patterns and check keyboard access. Benchmark staging before/after, inspect representative authenticated query plans and address demonstrated bottlenecks while preserving safe scope.

After tests/review, deploy additive migration008 to staging before preview app; exact-SHA preview and hosted acceptance, verify complete synthetic cleanup. Then production migration before exact-SHA main application deployment, read-only production smoke and CI. Archive safe evidence without environment/link/auth files, preserve original env files, remove task worktree after integration. No fabricated successful reads or timeout suppression.
