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
