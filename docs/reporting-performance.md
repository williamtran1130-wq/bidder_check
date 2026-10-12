# Reporting performance diagnostics

Deployment verification began on October 12, 2026 after explicit authorization to deploy through production. The initial read-only observations below are the pre-release baseline; they do not describe the current staging schema.

## Hosted investigation during release

Supabase CLI authentication allowed read-only Management API queries despite the unavailable direct database hostname. Catalog inspection confirmed migrations through `202610070001` before rollout. Production had 11,236 bids at the release check, so the dedicated staging benchmark uses 25,000 synthetic bids plus 18 retained rows. No production records are copied into staging.

The old production `dashboard_performance` function took **6,666 ms** for the current-month report under an existing approved workspace owner's authenticated role. `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` reported 44,611 shared-buffer hits and 2,835 temporary blocks read / 567 written. The production `authenticated` and `authenticator` deadlines are eight seconds; anon is three seconds. No global deadline was raised. This demonstrates poor headroom in the old report, but does not reproduce or identify the exact earlier customer timeout. A production Vercel log search for the timeout text over the preceding 24 hours returned no matching entries.

The first staging acceptance run made 450 authenticated REST requests in waves of five against 25,000 bids. All allowed report totals reconciled and all 50 bidder earnings requests were denied, with no statement timeout. Client All time dashboard p95 was **2,153 ms**, so that version failed the two-second release gate. The other dashboard p95 values ranged from 777 to 1,752 ms.

Plan investigation showed the report event helper returning raw application tuples and spilling large intermediate results. The final helper aggregates by day, metric, bidder, profile and assignment, summing each count/amount before returning rows. Date and authorized-scope filtering still happens first. A representative bounded local fixture compressed 12,500 event tuples to 21; the instrumented function stopped writing temporary blocks. The regression suite includes mixed live/retained cohorts and checks every aggregate measure. These local measurements explain the change; the repeated hosted benchmark is the performance acceptance evidence.

The repeated staging run **passed** with the same 25,000-bid/18-retained-row fixture, 450 authenticated requests, 25 samples per role/RPC/range and five concurrent readers. It included initial requests without discarding warm-up samples. The financial enforcement migration was active. All permitted payloads reconciled fixture truth, all 50 bidder earnings requests were denied, and no statement timeouts occurred.

| Dashboard p95 | All time | Last 30 CT dates (bounded diagnostic input) |
| --- | ---: | ---: |
| Client | 1,041 ms | 552 ms |
| Admin | 599 ms | 544 ms |
| Bidder | 568 ms | 481 ms |

All interview and permitted earnings p95 values were at most 723 ms. The slowest individual request was 1,231 ms. Client All time dashboard p95 improved by about 52% relative to the first run. This benchmark does not change the calendar presets exposed in the UI. `scripts/reporting-staging-benchmark.mjs` refuses any database except the dedicated staging project; it creates synthetic users/data and removes them in `finally`. Post-cleanup exact counts confirmed zero synthetic bids, retained rows, assignments, candidate profiles, bidder memberships, workspaces and accounts. The ignored receipt is `test-results/reporting-staging-benchmark.json`.

Both staging and production reported PostgreSQL 17.6, `work_mem=2184kB`, `shared_buffers=224MB`, and 60 maximum connections. The production write gate remained open. No database capacity, timeout or memory settings were changed. The provider's billing/compute tier was not independently queried.

## Initial pre-release hosted state

The command used the existing environment files without printing their values. Production uses `.env.local`; staging uses `.env.staging`. Results were collected at approximately 12:14 UTC. API requests used HEAD for exact table counts, returned no private rows, and had an eight-second client deadline.

| Read-only measurement         |          Production |             Staging |
| ----------------------------- | ------------------: | ------------------: |
| Bids (including trash)        |              11,228 |                   0 |
| Retained daily aggregate rows |                   0 |                   0 |
| Bidders                       |                  14 |                   0 |
| Resume assignments            |                  18 |                   0 |
| Candidate profiles            |                  12 |                   0 |
| `dashboard_performance_v2`    | HTTP 404 / PGRST202 | HTTP 404 / PGRST202 |
| `earnings_performance_v2`     | HTTP 404 / PGRST202 | HTTP 404 / PGRST202 |
| `interview_performance`       | HTTP 404 / PGRST202 | HTTP 404 / PGRST202 |

Production exact-count API calls took 803–1,035 ms; staging calls took 751–1,309 ms. Missing-RPC probes took 336–893 ms in production and 301–792 ms in staging. These include network and REST overhead and are **not query execution times**. PGRST202 establishes that the RPC is absent from the exposed schema cache; direct catalog verification would be necessary to distinguish absent SQL from a stale cache.

Production has an API service key but no `SUPABASE_DB_URL` or `SUPABASE_DB_PASSWORD`. Staging has a database password; the direct `db.<project>.supabase.co` hostname returned `ENOTFOUND`, preventing PostgreSQL catalog queries and EXPLAIN. No authenticated role JWTs were configured for REST benchmarking. The script does not create users, obtain sessions, change claims outside local database transactions, or mutate either database.

The initial sandbox attempt returned EACCES before any request reached the API. The approved read-only network rerun produced the measurements above. EACCES and ENOTFOUND are environment/connectivity failures, not database statement timeouts.

## Timeout evidence and limits

The existing implementation notes describe handling SQLSTATE `57014` as a retryable no-commit import error. This diagnostic run observed **no 57014 response**. It did not capture the original failing reporting request, original date/filter/role inputs, database logs, or its plan, so neither the exact original query nor its root cause is established by these measurements. Report performance validation must compare the known failing reporting request before and after migration where possible. Do not infer a hosted fix from local PGlite regressions or from HEAD count latency.

## Reusable read-only benchmark

Run from the repository root with installed dependencies:

```powershell
node --env-file=.env.local scripts/reporting-diagnostics.mjs
node --env-file=.env.staging scripts/reporting-diagnostics.mjs --benchmark
```

The script emits only table counts, function/index names, timing, role labels, plan counters, and error codes. It never prints tokens, user IDs, query results, connection strings, or private error messages. `REPORT_ENV_LABEL` adds a nonsecret label to output; `REPORT_TIMEOUT_MS` selects a bounded 1,000–15,000 ms deadline (default 8,000). No blanket server timeout is changed.

For direct PostgreSQL, configure `SUPABASE_DB_URL` with the project's correct session pooler URL if direct DNS is unavailable. If only a password exists, the script attempts the project's direct hostname. Every database operation is inside `BEGIN READ ONLY`, with transaction-local statement and lock deadlines, and rolls back. The script inventories deployed v2 routines and indexes, obtains estimated table sizes from PostgreSQL statistics, and selects one existing active approved account per admin/client/bidder role internally. It never prints those account IDs.

Database TLS always verifies the server certificate and hostname. If the project's certificate requires an additional trusted CA, set `SUPABASE_DB_CA_FILE` to that PEM file (or supply `sslrootcert` in the connection URL). Insecure SSL connection-string overrides are removed; certificate failures stop the diagnostic rather than bypassing verification.

With `--benchmark` and deployed v2 functions, each available role runs the All time RPC through `SET LOCAL ROLE authenticated` and transaction-local `auth.uid()`/role claims. It captures `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, then performs five simultaneous reads using independent database connections. Bidder earnings denial is expected; dashboard and interview calls should succeed with no financial output exposure. Five-read durations include connection establishment. The EXPLAIN wrapper exposes the outer function call and buffer counters; it does not expose the SQL statements executed within PL/pgSQL. Nested plan analysis requires a separate authorized database logging/auto_explain workflow, not a claim that the outer Result plan proves index selection.

If PostgreSQL remains unavailable, configure existing short-lived `REPORT_ADMIN_JWT`, `REPORT_CLIENT_JWT`, and/or `REPORT_BIDDER_JWT` privately in the invoking environment. The script performs five simultaneous REST report reads per configured role, uses the publishable key, discards response bodies, and emits only status/code/timing. It does not mint tokens or sign users in. An empty authenticatedBenchmark array means no JWTs were supplied, not that concurrency passed.

## Required staging acceptance before performance claims

1. Apply the additive reporting migration through the normal reviewed deployment process, and verify all three RPCs resolve. This script never applies migrations.
2. Provision isolated synthetic staging fixtures through a separately authorized fixture process. Use at least **22,456 bids** (twice the production count observed here), with skewed shared profiles, multiple bidders, trash, varied first/latest dates, old history-only days, and retained rows. The production observed retained count is zero; include nonzero history to exercise retention paths anyway. Do not copy production private records.
3. Run representative approved client, admin, and bidder All time and bounded requests, plus the original reported failing input. Run five concurrent reads per role and record individual durations/error codes, execution time, buffer counts, and the configured server deadline. The current script supplies All time benchmarks; bounded cases can be run with the same read-only transaction setup and explicit RPC date arguments.
4. Verify counts/groups agree with fixture truth and series length is <=120. Measure both cold/warm executions where operationally feasible. Accept only with **p95 below two seconds and no statement timeouts** under five concurrent readers at twice production volume; restricted financial reads must remain denied. Collect enough repeated samples to make the percentile meaningful; a single five-read batch is a diagnostic, not the full acceptance benchmark.
5. Record fixture size/distribution, migration state, hardware/service tier, exact role/range/filter inputs, and before/after measurements. Preserve inner-query plans if needed to explain any remaining timeout. Cleanup of synthetic staging fixtures belongs to the separately approved fixture process.

The functional regression command is `npm.cmd test -- tests/reporting-v2.test.ts` (13 passing checks at implementation time). It applies all migrations in isolated PGlite and validates authorization, retained/live totals, grouping, CT dates, and bounded buckets. It is a correctness check rather than a hosted-scale benchmark.
