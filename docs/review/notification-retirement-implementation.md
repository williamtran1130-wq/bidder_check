# Notification retirement implementation

The workspace no longer exposes a Notifications navigation item, header bell, unread counters, message scheduling, browser push preferences, delivery, or polling. Ordinary toast feedback and account approval in People remain. `/notifications` redirects to `/dashboard`. The retired cron endpoint returns HTTP 410 with a JSON message; the read handler returns HTTP 410 for retired operations before authentication or database access.

Shared read isolation now uses `workspaceActorScope` in `src/lib/actor-scope.ts`. Identity, role, approval/archive state, and canonical workspace membership still isolate private cached resources; file and upload caches still reset on access revocation.

`202610310003_retire_notifications.sql` explicitly removes notification routines, the signup-resolution trigger, and five notification tables in dependency order, without CASCADE. It replaces the signup function with the same provisioning, reservation and pending-approval behavior minus alert insertion. It unschedules only `bidder-check-notifications`, removes the scheduler entry point, and deletes only its three Vault configuration entries when optional integrations exist. Storage cleanup jobs, tables, routines and secrets remain.

The old worker URL remains as a temporary retirement worker that unsubscribes its own push subscription and unregisters itself on activation. Browser cleanup selects only same-origin `/push-worker.js` registrations and preserves registrations containing another worker script, including a replacement waiting to activate. Keep this asset through the client migration window. It never requests permission, registers a worker, or displays a notification.

Removed `web-push`, its type package and transitive dependencies, notification environment variables, worker smoke script, scheduling configuration, and notification-only tests/preview harnesses. General smoke scripts retain account, provisioning, bid, financial and upload checks while removing notification API/table reads. Historical rollout/deployment notes are marked superseded.

## Verification

Tests first demonstrated the previous cron 401 and worker missing retirement behavior, and the old tables remaining after migrations. The all-migrations PGlite scheduler test then passed with the retirement migration. Its fixture now populates all five notification tables and supplies separate notification, storage and unrelated Cron jobs plus Vault names; the assertions prove retirement deletes only notification state and preserves signup, storage jobs, storage secrets and unrelated jobs. General database regressions continue to verify public signup remains pending, managed provisioning stays approved, and People approval succeeds after alert storage removal.

Targeted verification passed: `npx.cmd vitest run tests/notification-retirement.test.ts tests/scheduler-database.test.ts tests/actor-scope.test.ts tests/private-review-staging-smoke.test.ts tests/private-review-production-smoke.test.ts tests/server-recovery.test.ts tests/screenshot-size-benchmark-plan.test.ts tests/screenshot-size-benchmark-recovery.test.ts` (8 files, 89 tests). The final worker/scheduler focused rerun passed 7 tests, including a replacement worker waiting to activate.

`tests/database.test.ts`, `tests/workspace-names.test.ts` and `tests/review-correctness-database.test.ts` also passed through all migrations. Both hosted smoke scripts passed `node --check`; no hosted smoke, remote schedule mutation, deployment or migration was run. Focused notification lint passed with zero warnings or errors. An early full-suite run was stopped at the root agent's request while other agents were still integrating changes; root integration verification supplies authoritative final lint/typecheck/full-suite/build results.

## Release considerations

Deploy the compatible application and retirement migration as one planned release. The migration intentionally deletes historical notification content and subscriptions. Historical deployments must not recreate notification cron/function definitions. Deployment-platform notification environment values and any out-of-repository schedules require removal during the authorized release; this task made no remote changes.
