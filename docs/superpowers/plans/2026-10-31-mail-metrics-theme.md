# Mail Metrics, Theme Consistency, and Production Release Implementation Plan

> For agentic workers: use superpowers:executing-plans. Track each task and evidence in the plan-scoped ledger.

**Goal:** Deliver consistent original theme and Mail Check metrics in Overview, Earnings and Interviews, then release both apps.
**Architecture:** Existing report API + shared loading/projection; independent bid/mail errors; no migration or dependency.
**Tech Stack:** Next.js 16/React 19/Recharts/Supabase; Vite/React/Python/Electron.
**Spec:** docs/superpowers/specs/2026-10-31-mail-metrics-theme-design.md

## Global constraints
Preserve local changes and running apps. Dedicated branches in existing checkouts are approved. Read installed Next docs. No raw message transfer. CT dates and 90-day retention. Stable ID joins. Existing financial auth. Version desktop 0.5.1 only. Production release is authorized.

## Review focus
Missing coverage must not become zero/complete. Shared group sums must not inflate unique totals. Filter changes must not leak stale scoped data. Persisted collapse must not overwrite preferences at mount. Packaged source and production source must match verified commits.

### Task 1: Release baseline and credential compatibility
- [ ] Save design/plan; establish feature branches and baseline tests.
- [ ] Review existing credential storage diff, exercise regression tests and real isolated keyring; commit separately.

### Task 2: Shared mail metrics and theme
- [ ] Add failing aggregation tests for assignment grouping, dedup, missing/partial/zero coverage, bucket clipping and ratios.
- [ ] Implement shared projection and one-query loading hook; support required-workspace idle state, freshness and independent errors.
- [ ] Apply spec palette and original semantic light/dark tokens in both apps, remove blue gradients. Check readable contrast; keep category identity.
- [ ] Run focused tests and commit.

### Task 3: Overview confirmations and saved collapse
- [ ] Add failing layout/metric/state regressions.
- [ ] Share snapshot with email section; add third series and grouped metric with exact values; union email-only groups.
- [ ] Move email section below comparisons; collapse activity only, persist per scope+workspace with safe mount/storage handling.
- [ ] Run targeted checks and commit.

### Task 4: Earnings and Interviews
- [ ] Add failing view/report regressions for grouped counts, ratios, admin and embedded scope.
- [ ] Add Earnings card and adjacent column/unique total; preserve money math and union mail-only groups.
- [ ] Use mail invitations throughout Interviews; align first-applied denominator to effective mail range, replace conversion labels and handle missing/partial coverage.
- [ ] Pass minimal role/workspace props from server pages; add admin selector and pinned embedded workspace.
- [ ] Run targeted checks and commit.

### Task 5: Verification and whole-branch review
- [ ] Bidder lint/typecheck/unit/database/types/benchmark/build/browser checks.
- [ ] Mail Python/smoke/frontend tests+build/desktop tests, packaged E2E with runtime stripped PATH, isolated upgrade/keyring checks.
- [ ] Fresh code reviewer; fix material findings with failing regressions, rerun affected full suites.

### Task 6: Production release
- [ ] Bump desktop+lock to0.5.1; isolated output release-0.5.1; build assets and checksums; create draft release.
- [ ] Push reviewed commits and require green CI; deploy Bidder existing Vercel production project, verify READY/source.
- [ ] Synthetic production applications+snapshots verify all metrics and auth isolation; remove fixtures.
- [ ] Publish desktop stable release and verify remote asset digest. Record source refs/deployment/assets/QA in release docs; retain previous deployment/release rollback targets.
