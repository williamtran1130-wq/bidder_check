# Workspace logic, API and network review — October 31, 2026

## Implemented changes and evidence

The review covered authentication/approval, people and accounts, shared profiles
and assignments, bid editing/imports, screenshot verification/retention, reports,
settings, notification retirement, and the mail-check publishing boundary. Private
responses retain live authorization; bidder payloads do not gain financial or
screenshot access through the new IP fields.

| Priority | Finding | Implemented result / evidence |
| --- | --- | --- |
| High | Visible notification polling ran every 30 seconds, in addition to notification worker activity. | Removed page, bell, polling, scheduling/delivery code, push dependencies and notification data. Known database cron is unscheduled; external schedule removal is a release step. |
| High | Interviews first loaded unbounded applications, then another denominator after mail coverage arrived. | One authorized report bundle and matching SSR seed; first-applied applications and invitations share one common covered period. Browser checks cover seeded Strict Mode and date/group changes. |
| High | Report functions repeatedly aggregated live bids and expanded the mailbox JSON snapshot. | Transactional grouped daily bid counters, normalized mail metadata/counts, retained history read once, and a raw-reader rollback switch. Differential fixtures and reconciliation protect totals. |
| High | IP details required extra reads per displayed screenshot and excluded bidders. | Latest location is in the paginated authorized list, with server-side country filtering/counts. No per-row IP HTTP calls. Locations survive image expiry, but disappear with permanent bid deletion. |
| Medium | Mail collection timestamp changes could resend complete unchanged cubes. | Negotiated v2 full/delta/metadata-only publishing, durable acknowledgements, unchanged-work skipping and persisted jittered backoff. Server validates changed cubes without rewriting an intermediate full JSON blob. |
| Medium | Repeated focus/navigation reads and eager prefetch consumed invocations. | Actor-scoped bounded browser cache, 270-second visible refresh, hidden-tab suspension, explicit invalidation and disabled expensive navigation prefetch. Manual Refresh can supersede an older in-flight read. |
| Medium | Successful reads logged on every request. | Production success sampling at 1%; slow operations and failures remain logged without private response data. |

The local benchmark evidence is
`docs/release-evidence/2026-10-31-workspace-reporting-benchmark.json`. At 22,576
synthetic bids, owner All time queued-read p95 changed from 409.31 ms to 27.99 ms;
all tested role/range results agree, with zero reconciliation differences.
Authenticated edit RPC p95 was 1.41 ms before and 1.36 ms after in this run. Raw
UPDATE p95 increased from 0.48 ms to 1.12 ms: stored summaries add maintenance work.
These timings describe one local embedded database, not production billing or
independent hosted concurrency.

## Independent review findings addressed

An independent reviewer inspected migrations, report/cache/sidebar integration,
the application IP boundary, notification retirement and publisher changes. Three
concrete findings were resolved:

1. The rate denominator could include archived bidder assignments or blank-email
   assignments excluded from the mail projection. The cohort now consumes the
   exact projected assignment set. Tests cover mailbox filtering, blank email,
   archived assignments and bidder financial denial.
2. Legacy report authorization functions raise `Access denied` with SQLSTATE
   `P0001`, which was incorrectly treated as a transient error. The API now maps
   these to forbidden, checks bidder earnings access explicitly, and clears
   private browser state on authorization failure. Tests cover role changes,
   typed account revocation and private error suppression.
3. Sidebar response recency was incorrectly compared using the collection's own
   timestamp. Mailbox removal can move that timestamp backwards. Acquisition time
   now determines which response is newer, including coverage-only updates.

Additional integration checks restored missing-arrangement behavior instead of
inventing arrangement breakdowns, preserved manual Refresh during in-flight
reads, and made normalized retention pruning and the rollback switch operational.

## Final local verification

- Bidder-check unit/database suite: 89 suites, 834 tests passed. After final
  integration adjustments, seven affected suites (64 tests) passed again.
- Production build, ESLint, route generation/TypeScript, and generated database
  types checked against all executable migrations passed.
- The desktop/mobile browser run passed 303 of 304 scenarios. The remaining
  selection test mutated a fixture before its initial list query completed under
  parallel load. It now waits for completed pagination before editing. That check
  and report-cache/hidden-midnight checks passed 12 repeated runs across both
  device configurations. Final mail-metrics/chart checks passed another eight
  scenarios. This records a full run plus targeted verification, not a single
  304-pass rerun.
- Mail-check independently reverified: 49 publisher pytest tests, 161 unittest
  tests, and 331 standalone smoke checks passed. Bare full pytest retains nine
  pre-existing smoke-fixture setup errors; use the supported unittest/standalone
  smoke commands. Pytest cache-write warnings in the restricted workspace did not
  affect the publisher results.
- Visual inspection covered the desktop dashboard and sparse mail activity
  points. Test-only servers were stopped after verification; unrelated existing
  processes and untracked user files were preserved.

## Remaining measurements and opportunities

- Hosted cold/warm concurrency, Vercel CPU, and seven-day post-release usage remain
  release checks. No deployment or hosted mutation was performed locally.
- Private screenshots keep existing compression, explicit opening, bounded signing
  and retention. Do not use public storage or long-lived URLs to chase cache hits.
- The location helper currently projects authorized locations before the list's
  page joins. If hosted list plans show this becoming material, split country-only
  filtering from page-only JSON projection; maintain the existing authorization
  boundary and count/filter parity tests.
- People/profile/resume loaders remain scoped and role-safe. Further pagination
  or narrower projections should be driven by measured response bytes rather than
  removing data needed by editing and assignment dialogs.
- Avoid adding Realtime subscriptions, public authenticated-page caches, a new paid
  cache service, or background heartbeats without measuring their complete cost.
  The current design reduces requests within the existing stack.

Rollout, repair and measurement instructions are in
`docs/workspace-reporting-rollout.md`. The IP and notification implementation
reports provide subsystem test details; the publisher report is in mail-check's
`docs/review/2026-10-31-publisher-v2.md`.
