# Bidder Check implementation ledger

Current authority: the user-approved 2026-10-29 screenshot-retention/permanent-deletion plan. The entries below are historical; the [current rollout](screenshot-retention-deletion-rollout.md) supersedes their recoverable trash, library archive, automatic-preview and staging-first rules.


Authority: the user-approved implementation plan in this conversation, 2026-09-28.

## Sequence

- [x] Foundation and authentication
- [x] Tenant security and management
- [x] Resume management
- [x] Bid workflow
- [x] Dashboard and earnings
- [x] Local verification (20 unit/database tests; 14 desktop/mobile browser tests; lint, typecheck and production build)
- [x] Initial production/staging migrations, admin bootstrap and Vercel deployment
- [x] Direct-account update: eight hosted workflow checks passed; production release ready

## Decisions and evidence

- Empty repository; no baseline tests or existing user files. Feature branch created in the existing workspace because there is no initial commit to base a linked worktree on.
- Public signup is always client; database invitation lookup alone provisions bidder roles.
- Shared interfaces: auth profiles -> workspace access -> resumes -> bids -> earnings. Ownership and financial transitions are enforced in PostgreSQL, not inferred from UI visibility.
- Missing deployment credentials will be reported precisely; local implementation continues independently.
- Ruling: privileged file finalization is required in addition to Auth administration. The server downloads bytes using the caller's JWT, validates the signature/size, then records SHA-256 through a service-only function. An authenticated client must never be able to assert its own content hash. Cost: verified uploads also require the server secret.
- Ruling: Docker is installed but its daemon is unavailable. Database tests execute the real migration in PGlite with Supabase Auth/Storage schema equivalents. Cost: hosted email delivery, Storage HTTP behavior and multi-connection PostgreSQL concurrency still require staging smoke tests.
- Ruling: component browser tests use a separate Vite fixture application, never a production demo/auth bypass. Cost: these verify UI behavior, not live authenticated Supabase workflows.
- Pinned TanStack Table to version 8 and Zod to version 4 to match the implemented APIs. Node 22 is pinned for deployment and available through the local dev dependency.
- Independent review found four issues, all fixed with regression coverage: premature invitation acceptance/resend failure; cross-workspace reservation race (email advisory lock plus ownership-guarded upsert); raw RPC URL canonicalization bypass; browser/server timezone mismatch.
- Browser accessibility tests exposed insufficient muted-text/avatar contrast; tokens were corrected. Playwright's test teardown requires unsandboxed process cleanup on this Windows host; the completed run exited successfully with 14/14 tests passing.
- Deployment access supplied: initial schema installed in production and isolated staging, all eight application tables have RLS, and storage is private. Production is https://bidder-check.vercel.app; staging is https://bidder-check-staging.vercel.app.
- Designated initial administrator: david.chan.mdev@gmail.com. Bootstrap requires an existing verified account; no password is generated or committed.
- Reviewer deferred hosted Auth/email, Storage HTTP, deployment configuration, production concurrency/performance, and screenshot semantic authenticity. Ruling: staging verifies hosted integrations; screenshots are checked for actual bytes, file signature and exact rejected-content reuse, not semantic proof of a real application.
- User revised onboarding: no SMTP, no bidder invitations, initial bidder password `123456`, and immediate client signup without email verification. Settings supports password changes. Password recovery guidance refers users to their manager/administrator.
- Hosted testing discovered that bidders could unapply their own bids. Migration 002 now requires manager authorization and a correction reason; the bidder UI hides that control. Regression tests fail before the fix and pass after it.
- Migration 003 provisions bidders using a manager-reserved UUID passed through server-only Auth `createUser(id)`. Supabase applies custom app metadata after inserting the user, so trigger authorization cannot depend on it. Public signup cannot select an Auth ID or use editable metadata to claim a reservation.
- Follow-up security review found no blocker in the new account flow. Production has zero legacy unconfirmed bidder accounts, so the old invitation conversion concern does not apply.
- Full hosted Playwright journey passed on Vercel staging (2026-09-29): immediate signup; direct bidder creation/default-password login/password change; private resume upload/download; invalid screenshot rejection; screenshot application; direct HTTP tenant/storage/role restrictions; correction/new proof/original rate/concurrent retry behavior; earnings and archival. Synthetic users/files were removed afterward. Local report: `test-results/hosted-smoke.json` (ignored).
- Production migrations 001–003 and immediate-signup configuration applied successfully. Git commit `ffd5474` is deployed READY in both environments; production deployment `dpl_4rJ8zXEdvLHPVYx72AkmES2sRcKF`. Local CLI uploads encountered connection timeouts, so release used the existing GitHub integration. No SMTP setup is required.

## Approval and daily workflow update ? 2026-09-29

- Implemented migrations 004?006: approval state, tenant restrictions, account audit, transactional email synchronization, recoverable bid trash, immutable Found time, and atomic verified screenshot application.
- Existing clients remain approved; public clients start pending. Account editing, approval/rejection, reset confirmation and Client ? Bidders hierarchy are available in Users.
- Chicago Today / All / Custom table query is independent of reporting. Expanded columns include signed visible-row previews and inline screenshot upload. Trash is excluded from reporting and keeps evidence/history for restoration.
- Review identified stale account reservations after email changes. Reproduced in PostgreSQL tests; migration 006 moves the reservation with its Auth account. Browser tests identified a TanStack render loop; memoized filtered rows resolve it.
- Final local verification: 32 unit/database tests, 16 desktop/mobile browser tests, lint/type checking and production build passed. Hosted staging passed all 13 checkpoints and cleaned its generated data. See docs/deployment.md for release identifiers.

## Spreadsheet editing and import decisions - 2026-09-30

- Implemented the approved plan on an isolated feature branch in the existing clean checkout. Release to staging and production was already authorized; no additional permission gate was added.
- Kept the 512 KiB clipboard limit. Mapped JSON allows 2 MiB and Server Actions allow 3 MiB to accommodate JSON escaping and repeated defaults; the tradeoff is a bounded larger HTTP request allowance.
- The review's fixed-bidder workspace-selector issue was treated as important because it could strand an admin import. Embedded bidder imports now keep client and bidder fixed; an admin uses the unscoped Bids page to import for a different client.
- Hosted behavior and maximum-size behavior remained release checks, not feature exclusions. The 500-row UI/database checks and full hosted workflow passed. Existing axe/mobile checks passed; these are not an unrestricted production load benchmark.
- Fixed all four important review findings: URL canonicalization, keyboard focus initialization, selection reconciliation and copy bounds after row removal, and page clamping. Also fixed queued focus closing double-click editors. No deferred minor findings remain.
- Final local results: 44 unit/database tests, 34 desktop/mobile browser checks, lint/type checking and production build passed. Hosted staging passed all 14 checkpoints and removed its synthetic data.


## Bulk actions and cleaner table controls - 2026-09-30

- Added adjacent heading actions, independent cross-page checkbox selection, expected-version atomic bulk trash/restore, and manager-only permanent deletion with typed DELETE confirmation against an expiring actor-bound snapshot.
- Screenshot metadata/history removal and durable cleanup tasks commit together. Physical objects are removed with the Storage API, followed by delayed verification. Pending tasks and authorized retries survive reloads; import receipt fingerprints prevent deleted bids returning through old requests.
- Removed text defaults and header handling from Sheets import. All rows are data. Background refresh retains the table and reserves spinner space; retryable failures retain prior results. Screenshot controls remain mounted during table updates.
- Fresh whole-branch review found older unfinished cleanup disappeared after ten newer operations. Reproduced RED in the database regression, fixed to retain every pending operation, and verified GREEN. No deferred minor findings.
- Verification: 51 unit/database tests, 40 desktop/mobile browser checks, lint, type checking and production build pass. Staging deployment `dpl_8zJb28uuw7JzzWcZCEu4NYEfWZNs` at commit `9b5b27c` passed all 16 hosted checkpoints, including synthetic permanent deletion and delayed in-flight upload removal. Synthetic records/files were cleaned up.
- Execution decisions: used the existing clean checkout on a feature branch and the already-authorized staging/production release path; no separate worktree was needed. Five-minute verification exceeds current upload timeout and signed URL lifetime, with daily/manual retry for pending work; an upload outliving that window would need another verification. Hosted behavior was gated on the completed staging journey, not inferred from local tests.

## Signup alerts and workflow fixes — 2026-10-05

- Implemented directly on `main` as explicitly requested. Public registrations atomically publish private admin approval alerts; database identity reservations distinguish admin-created approved accounts without trusting signup metadata. Existing retention policies stay unchanged; newly created candidate profiles default to two calendar months.
- Assignment forms select the PDF before saving and retain the incomplete assignment ID and draft during upload retries. Success clears that ID; reopening the form cannot overwrite the previous assignment. Invalid MIME/size is rejected before saving.
- Imports remain clickable for validation/retry. Transport failures and post-commit revalidation failures freeze the request ID and payload until the result is resolved. Definite database rejections allow correction.
- Fresh final review found five important issues: uncertain imports, stale assignment IDs, file prevalidation/removal, archived approval destinations, and push subscriptions rebound to another user. All were reproduced and fixed with failing-then-passing regressions. No deferred findings. Push claims and dispatch recheck device ownership; reassignment clears old attempts.
- Full browser verification exposed an editor blur resubmitting a successful save before React committed the closed editor. A completion guard fixes the race; ten repeated keyboard journeys and the full browser suite pass.
- Local verification: lint, typecheck, 99 unit/database tests (43 database), 70 desktop/mobile browser tests, and production build passed. Hosted staging passed 21 checkpoints and confirmed physical cleanup; release identifiers are recorded in `docs/deployment.md`.
- Real Chrome staging testing found push subscription attempted before service-worker activation. A failing browser regression reproduces it; activation waiting and a visible provider-error fallback fix it without affecting inbox delivery.
- Production scheduler verification exposed a preexisting Proxy redirect to the sign-in page for the notification worker. HTTP 200 alone was insufficient evidence: it was HTML. The worker now uses its own bearer authentication; service-worker and manifest assets are public. Proxy/browser regressions reproduce the redirect, and hosted smoke checks require JSON from the worker.
- The real HTTP staging worker published a synthetic scheduled message exactly once across retries; the stable staging alias also returned JSON through Supabase's scheduler. A transient local browser failure was traced to Windows socket error 10055 (`ERR_NO_BUFFER_SPACE`), followed by ten passing isolated runs and all 70 browser checks passing without application changes.
