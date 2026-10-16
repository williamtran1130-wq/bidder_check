# Supabase egress reduction — 2026-10-16

## Behavior

Screenshot authorization still uses caller-JWT private reads, batched file lookup,
Storage RLS, 60-second signed URLs, and a 15-second renewal lead. Successful renewal
updates authorization expiry without replacing an already-loaded image source.
The enlarged viewer obtains a current URL when opened and retains its source while
open. Actor/file changes, failed reads, image errors, and access revocation invalidate
the affected display. Expired authorization hides an existing image while a slow
renewal is pending. No original files, hashes, byte-size metadata, or APIs change.

Screenshot renewals and purge-status polling stop in hidden documents. An open
viewer retains its access checks when the table cell is offscreen. Returning tabs
reconcile access/status once. Notification polling and scheduled workers retain
their existing behavior. No schema migration is required.

## Local evidence

- Clean starting revision: `f13df07`.
- Regression before the fix: 25 mounted screenshots caused 175 image requests over
  five simulated minutes with a distinct signed token on each renewal.
- After the fix: 25 image requests and seven signing batches for the same session,
  on desktop and mobile. This is an 85.7% reduction in **synthetic image requests**,
  not a measurement of production egress bytes or a guaranteed monthly saving.
- Unit/full-schema database suite: 764 tests in 80 files passed with two workers.
- Lint and typecheck passed. A production build passed using `--webpack` locally;
  the worktree's shared dependency junction is outside Turbopack's filesystem root.
- Independent review found no Critical/Important issues. Its suggested active-purge
  completion/visibility case was added and passed on desktop and mobile.
- Browser coverage includes stable sources, fresh dialog access, visibility,
  offscreen/dialog behavior, failed renewal, explicit retry, image errors, actor
  replacement, unmount, revocation, expired/slow access, notification visibility,
  late purge responses, and the six-second cleanup-completion display.

## Organization baseline and monitoring

The supplied dashboard shows 6.974 GB uncached egress against 5 GB and 0.006 GB
cached egress, for September 29–October 29, 2026. This is an aggregate screenshot,
not a live daily export. Read-only CLI inventory confirmed two active projects in
organization `awphyrnenkpzslvxwwvr`: production `aizorlyfggwbewetnwqm` and staging
`kdmvludtvhuuewmhurpw`. Daily project/service usage has not been obtained: dashboard
browser initialization failed, and project API credentials do not supply billing
usage. No per-project attribution is inferred from the aggregate.

Target a normal full billing cycle below **4 GB uncached**, with cached egress
tracked separately. Already accumulated traffic cannot be removed by this fix;
the current cycle cannot fall below a total it has already exceeded.

After production release, record deployment time and read usage after at least
the dashboard's refresh delay, then daily for seven days. For each day capture:
UTC measurement time, billing start/end, project, service, cumulative uncached GB,
and cached GB separately. Use the same boundaries for every sample.

- Daily increment = today's cumulative bytes minus yesterday's, within one cycle.
- Normal-cycle estimate = mean post-release daily increment × cycle length in days.
- Current-cycle forecast = already used bytes + mean increment × remaining days.
- A cycle reset starts a new series; do not interpret its negative difference as savings.
- Sum all projects/services before comparing with the organization budget.

If the normal-cycle estimate exceeds 4 GB, rank the remaining project/service
contributors and prepare a separately scoped follow-up. Private thumbnails,
persistent caches, paid upgrades, and provider migration are outside this release.
The grace period ends November 15, with enforcement stated to begin November 16.
The warning banner alone does not establish whether the reduction worked.

## Rollout gate

Deploy the reviewed revision to Preview with staging configuration, verify private
synthetic Storage bytes, signed expiry, tenant denial and fixture cleanup, then
release the same application revision with Production configuration. Record exact
deployment IDs and bounded production verification separately. Do not promote a
staging-configured build directly to Production. Seven-day quota acceptance remains
pending until actual usage observations are available.
