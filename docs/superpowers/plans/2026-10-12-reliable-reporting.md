# Reliable reporting implementation

Approved specification: the user's implementation request of 2026-10-12.

## Binding requirements

- Hide earnings and rates from bidders in UI and direct APIs; preserve manager access and stored history.
- CT calendar filters: Today, Yesterday, This week, Last week, This month, Last month, All time, Custom. Monday-start weeks, current periods through today.
- Focused dashboard with four nonfinancial cards, manager Earned card, activity, bidder/profile found-cohort comparisons; no embedded CRUD.
- Status-only read-only imports; silently exclude blocked rows; retain validation, locking, idempotency and exact retry payloads.
- Optimize scoped reports and correct retained/grouped totals; verify local results separately from hosted evidence.
- Fix assignment pagination and assignable-profile loading.

## Work packages

1. Calendar, dashboard/report UI and actions integration (root).
2. Report SQL, nonfinancial interviews, performance regression coverage (reporting agent).
3. Financial read boundary, safe transport/loaders, associated UI, permission tests (financial agent).
4. Bid eligibility/import workflow, status-only preview, relevant tests (imports agent).
5. Integration, review, fixtures/browser tests, generated types, diagnostics, documentation (root and reviewers).

## Validation and release

Typecheck, lint, unit/database tests, build, desktop/mobile browser coverage; synthetic performance and authenticated hosted checks where credentials permit. Additive migrations precede compatible app; financial enforcement migration follows compatible app. No historical migration rewrites. The original implementation phase excluded production mutation. The user's later instruction, "deploy start till production", authorizes the phased staging and production rollout; results are recorded in the deployment and reporting-performance documents.
