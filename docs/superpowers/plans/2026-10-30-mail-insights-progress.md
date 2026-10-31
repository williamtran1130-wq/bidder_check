# SDD ledger — plan: docs/superpowers/plans/2026-10-30-mail-insights-overview.md

Base bidder-check: f013130; base mail-check: 322ba25 plus existing unreleased desktop changes.

Ruling: use feature branches in existing checkouts — local mail-check has extensive unreleased desktop code/build dependencies that the approved feature builds upon; do not reset/stash/discard it. Publish release includes current desktop baseline plus integration. Existing bidder audit docs excluded from feature commits.

Preflight: local exporter and cloud schema use locked snapshot contract; local Settings uses locked connection API; Overview uses locked report contract. Database auth uses caller JWT; no ID-only fallback.

Tasks 1–5: pending.

Tasks 1–4: implemented. Initial TDD: SQL missing functions -> 6 passing; mailbox dashboard scope missing -> regression passing; API route missing -> 6 passing; UI 18 focused + 2 browser interactions passing; local Python 130 tests and frontend 74 tests passing.

Review fix pass: expired retry RED Invalid snapshot -> GREEN ledger checked before retention validation (8 SQL tests). Transient Auth error RED401 -> GREEN503 (7 API tests). Archived manager assignments restored by UI implementer with regression. Local selected-mailbox pending queue fix in progress.

Ruling: use official Supabase Auth REST with existing httpx rather than adding Python SDK — preserves the same password/refresh/get-user protocol without extra frozen-app dependencies. Complete sessions remain in OS keyring.

Ruling: require explicit workspace for admin mail reports — prevent duplicate email identities across separate client tenants from being collapsed; original all-workspace bid report remains available.

Production access: GitHub, Vercel and linked Supabase verified. Dry-run only new migration 202610300001 pending. Origin main df53cd0 is ancestor of current bidder base f013130, so deployment can fast-forward without dropping newer main changes.

Review fix pass complete, independently approved: all four Important findings addressed. Cloud final unit/database suite 870/870; lint/typecheck/build/schema-generation/benchmark manifest pass. Full browser run 341/342 passed; one Windows ERR_NO_BUFFER_SPACE navigation failure subsequently passed in the complete 12-case profile suite. Original seven integration browser regressions all corrected and verified (preview target, independently named errors, focusable scroll regions).

Local release bc1e22f: Python 134/134, frontend 74/74, desktop unit 4/4, packaged standalone E2E 1/1 (Python/Node removed from PATH; schema12 legacy backup and connection settings verified). Installer SHA256 e6a9717d3246d43d2e92cd7d2821b97e153c06adf08c25c8d25c15adc1a1355f. Isolated output preserved user's running 0.4.3 app.

Production migration 202610300001 applied successfully. Initial Git/CLI deployments blocked before build with COMMIT_AUTHOR_REQUIRED: configured email gemini06130324@gmail.com has no GitHub attribution. Ruling: use authenticated account's verified GitHub noreply identity for a new follow-up commit (same identity as prior production commits); no global Git configuration changes or history rewrite.

GitHub mail-check v0.5.0 draft contains installer, checksum, nupkg and RELEASES; remains draft until production end-to-end acceptance.
