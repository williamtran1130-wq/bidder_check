# Page defaults and optional layout polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start each reporting/work page with the requested period and optionally improve layout where a visual review identifies a clear usability benefit.

**Architecture:** Change the existing component state initializers and reuse the shared calendar resolver, selector, and reporting hooks. Keep optional layout changes separate from the required defaults; prefer small changes to shared layout components before page-specific adjustments.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Radix UI, Recharts, Supabase, Vitest, Playwright.

**Spec:** The user's latest request, reproduced in the required behavior table below. This is a bounded follow-up to the existing calendar/reporting implementation. This document is a plan; implementation and deployment have not started for this request.

## Global constraints

- Use the existing `America/Chicago` calendar: weeks start Monday, and This week runs from Monday through today.
- Maintain financial visibility and authorization: Earnings remains available to clients/admins; bidders retain nonfinancial reporting.
- Preserve manual selection, custom-range validation, CT midnight/focus refresh, same-filter retry behavior, and deferral during active bid editing.
- Keep the existing visual style, navigation, chart scope, and bid workflows. Layout polish is optional and must not delay the defaults change.
- No database migrations, new dependencies, filter-persistence feature, or report-query redesign is needed.
- Before implementation, read the relevant installed Next.js guides under `node_modules/next/dist/docs/`, as required by `AGENTS.md`. The installed Playwright guide is `01-app/02-guides/testing/playwright.md`.

## Required behavior

| Surface | Current default | New default | Component |
| --- | --- | --- | --- |
| Overview (`/dashboard`) | This month | **This week** | `src/components/dashboard.tsx:46` |
| Bid workspace (`/bids`) | Today | **Today** | `src/components/bids.tsx:315` |
| Earnings (`/earnings`) | All time | **This week** | `src/components/earnings.tsx:18` |
| Interview performance (`/interviews`) | This month | **All time** | `src/components/interviews.tsx:12` |

Defaults apply when the component initializes, including a fresh visit or reload. A selection made while the page remains mounted must continue to control its requests. Do not add an effect that repeatedly resets the selection. Keep existing navigation/remount behavior and introduce no cross-page persistence.

The shared Earnings component also makes the manager's Earnings tab in bidder detail start at This week. Embedded Bid activity keeps Today. `/bids?review=pending` and the pending-review shortcut keep their intentional All time override, while a successful historical import still selects its imported date.

## Task 1: Change defaults and preserve filter behavior

**Modify:** `src/components/dashboard.tsx`, `src/components/earnings.tsx`, `src/components/interviews.tsx`, `e2e/reporting.spec.ts`, `tests/preview/actions.ts`, `README.md`.

**Read/reference:** `src/components/bids.tsx`, `src/components/bidder-detail.tsx`, `src/components/period-selector.tsx`, `src/components/use-report.ts`, `src/lib/calendar-period.ts`, `tests/calendar-period.test.ts`, `tests/report-actions.test.ts`.

**Interfaces:** Keep `PeriodSelection`, `PeriodSelector`, `getDashboardPerformance`, `getEarningsPerformance`, and `getInterviewPerformance` unchanged. No production interface additions.

- [ ] Update the existing first test in `e2e/reporting.spec.ts` to assert these values immediately after visiting each route, before selecting another period:

  ```ts
  await page.goto(`${preview}/dashboard`);
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("this_week");
  await page.goto(`${preview}/bids`);
  await expect(page.getByLabel("Found period", { exact: true })).toHaveValue("today");
  await page.goto(`${preview}/earnings`);
  await expect(page.getByLabel("First applied period", { exact: true })).toHaveValue("this_week");
  await page.goto(`${preview}/interviews`);
  await expect(page.getByLabel("Cohort period", { exact: true })).toHaveValue("all");
  ```

- [ ] Run `npx.cmd playwright test e2e/reporting.spec.ts --grep "calendar filters" --project=desktop`; confirm it fails on the old Overview default. Playwright starts the configured app/fixture servers; run `npm.cmd run build` first if a production build is unavailable.
- [ ] Change only the three report initializers:

  ```ts
  // dashboard.tsx and earnings.tsx
  const [period, setPeriod] = useState<PeriodSelection>({ preset: "this_week" });

  // interviews.tsx
  const [period, setPeriod] = useState<PeriodSelection>({ preset: "all" });
  ```

- [ ] Keep `BidWorkspace`'s `"today"` initializer, review overrides, and import-date handling intact. Keep all eight selector options available.
- [ ] Correct the report reliability tests and their preview delay scenario together. `e2e/reporting.spec.ts` currently assumes initial dashboard totals of 12 found/8 applied; the fixed Monday clock produces 1 found/0 applied for This week with the existing fixture. Assert the initial range `2026-10-12 – 2026-10-12 CT` and chart `Activity chart: 1 found, 0 applications.`. In failed-refresh and late-response tests, switch to `yesterday`, whose successful fixture result is 1 found/1 applied, so stale replacement remains observable. Preserve the existing read-count assertions of 1, 3, and 5 for initial load and retries.
- [ ] In the custom-draft test, retain incomplete/reversed-date checks, then apply October 11–12 instead of the one-day default. Assert `Activity chart: 2 found, 1 applications.` and exactly two report reads after Apply. This keeps the test sensitive to both premature requests and a range that fails to update results.
- [ ] Make the delayed preview request target `this_week` in `tests/preview/actions.ts`, and expect `data-report-completed="this_week"` for the late old response. Preserve assertions that an old response cannot replace new-filter results, focus events reuse the in-flight request, failed reads never become zero totals, and incomplete custom ranges do not launch queries.
- [ ] Add minimal request recording to the existing Earnings/Interview preview mocks, which currently ignore their input. Use the production `GroupedReportQuery` parameter type and record the received payload without changing their displayed fixture totals. For example, inside the mocks:

  ```ts
  document.documentElement.dataset.earningsQuery = JSON.stringify(input);
  document.documentElement.dataset.interviewQuery = JSON.stringify(input);
  ```

  Add focused browser assertions that initial requests contain `period.preset: "this_week"` for earnings and `"all"` for interviews. Verify choosing another period and changing grouping preserves the selected period in subsequent calls. For example:

  ```ts
  await page.goto(`${preview}/interviews`);
  await expect.poll(async () => {
    const raw = await page.locator("html").getAttribute("data-interview-query");
    return raw ? JSON.parse(raw).period.preset : null;
  }).toBe("all");
  await page.getByLabel("Cohort period", { exact: true }).selectOption("last_week");
  await page.getByLabel("Group by", { exact: true }).selectOption("bidder");
  await expect.poll(async () => {
    const raw = await page.locator("html").getAttribute("data-interview-query");
    return raw ? JSON.parse(raw) : null;
  }).toMatchObject({ period: { preset: "last_week" }, group: "bidder" });
  ```

- [ ] Cover `/bids?review=pending` loading with `Found period=all` and the pending filter active. Keep the existing Today, custom-date, midnight rollover, and active-edit regression cases.
- [ ] Replace the defaults sentence in `README.md` with: “Bids default to Today, Overview and Earnings to This week, and Interview performance to All time.” Leave prior deployment/benchmark evidence unchanged.
- [ ] Run `npx.cmd playwright test e2e/reporting.spec.ts e2e/workspace.spec.ts e2e/notifications-interviews.spec.ts` on both configured projects. Run `npx.cmd vitest run tests/calendar-period.test.ts tests/report-actions.test.ts`. Review and commit the mandatory change independently from optional layout work.

## Task 2: Align hosted verification with the new defaults

**Modify:** `scripts/reporting-production-smoke.mjs`.

**Reference:** `scripts/hosted-smoke.mjs`, `src/components/bidder-detail.tsx`.

- [ ] Replace the smoke script's assumption that both report pages initially request `this_month`. Assert the initial Overview selector/request is `this_week` and Interview performance is `all`.
- [ ] Retain explicit coverage for This month and All time by selecting those periods deliberately; skip a selection only when that exact preset is already selected. Register response listeners before navigation/selection. Add the weekly dashboard case without relabeling existing monthly API measurements as weekly.
- [ ] Add a manager Earnings visit asserting `First applied period=this_week` and a successful report response. Preserve bidder Earnings redirection checks, existing financial-denial checks, and application-error assertions.
- [ ] In a staging browser session, verify bidder detail starts Bid activity at Today and Earnings at This week, with the selected bidder scope intact. Test an alternate period in each tab. Preview fixtures do not currently mount bidder detail, so do not claim that the standalone preview covers this integration.
- [ ] Run `node --check scripts/reporting-production-smoke.mjs` and `npx.cmd eslint scripts/reporting-production-smoke.mjs`. During implementation acceptance, run the updated smoke against the staging candidate with its staging environment configuration; inspect the script's environment guard before running it. This planning task performs no hosted mutations or deployment.

## Task 3: Optional visual review and small layout improvements

**Decision:** Review every user-facing page; change only layouts with demonstrated clipping, overflow, awkward wrapping, poor reading order, or difficult-to-reach controls. An unchanged page is an acceptable result. Keep this task independently skippable.

**Shared files:** `src/components/common.tsx`, `src/components/shell.tsx`, `src/components/period-selector.tsx`, `src/app/globals.css`.

**Page files and review targets:**

| Pages | Files | Review focus |
| --- | --- | --- |
| Overview | `src/components/dashboard.tsx` | Filter wrapping, card spacing, chart labels, expanded accessible values |
| Bid workspace | `src/components/bids.tsx`, `src/components/bid-grid.tsx`, `src/components/bulk-bid-toolbar.tsx`, `src/components/sheets-import.tsx` | Toolbars and mobile actions; preserve internal grid scrolling, editing, selection and status-only preview |
| Earnings / Interview performance | `src/components/earnings.tsx`, `src/components/interviews.tsx` | Period visibility before affected results, table scrolling, numeric alignment, loading/error placement |
| Resume library / Candidate profiles | `src/components/resumes.tsx`, `src/components/profiles.tsx` | Search/action alignment, long names, card density, dialog/sheet scrolling |
| People / Bidder detail | `src/components/people.tsx`, `src/components/bidder-detail.tsx` | Wrapping row actions, readable identity details, tabs, embedded reports |
| Notifications | `src/components/notifications.tsx` | Long message wrapping, readable form groups, reachable row actions |
| Settings | `src/components/settings.tsx` | Form width, appearance choices, account-security row stacking |
| Login, signup, recovery, password update, approval, inactive | `src/app/auth/layout.tsx`, `src/components/auth-form.tsx`, respective `src/app/auth/*/page.tsx` | Small-screen form spacing, visible validation, primary action and keyboard flow |
| Loading, error, not found | `src/app/(workspace)/loading.tsx`, `src/app/error.tsx`, `src/app/not-found.tsx` | Readable feedback and reachable recovery action |

- [ ] Capture baseline screenshots at 390px mobile and 1440px desktop; check 320px and 768px widths for wrapping. Use the existing isolated fixture for workspace components and staging for authenticated route/detail integration. Review relevant client/admin/bidder differences and light/dark themes; retain screenshots in `test-results/`.
- [ ] Record each actionable finding as route, viewport, visible problem, proposed file/class change, and before screenshot. Source review identified candidates below, but screenshots must confirm the need before changing them.
- [ ] If heading actions overflow, update the action wrapper in `PageHeading` from its current non-wrapping row to a responsive wrapping row. Keep desktop alignment and avoid constraining dense bid content:

  ```tsx
  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
    {children}
  </div>
  ```

- [ ] If the Settings account-security row clips on mobile, stack that existing row below the small breakpoint using `flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between`. If appearance choices clip at narrow widths, use `grid-cols-1 sm:grid-cols-3` for that existing group.
- [ ] If the Earnings period control is hard to associate with its summary cards, move the existing period/group toolbar immediately before the summary-card grid. Keep one selector bound to the existing state and preserve the table's grouping behavior. Do not add duplicated controls or state.
- [ ] For other confirmed issues, use existing spacing and responsive utilities in the file identified in the table. Keep wide tables inside their existing horizontal scroll containers, wrap long text, and let action groups wrap. Do not hide information to make a screenshot fit. Skip speculative changes and broad component rewrites.
- [ ] Verify affected pages by keyboard: visible focus, logical order, usable selector/custom dates, reachable actions, dialogs that scroll and close correctly. Capture after screenshots at the same sizes. Extend the relevant existing `e2e/workspace.spec.ts`, `e2e/people.spec.ts`, `e2e/profiles.spec.ts`, `e2e/notifications-interviews.spec.ts`, or `e2e/auth.spec.ts` only for a reproduced behavior regression; do not add tests that merely assert CSS class names.
- [ ] If shared shell/heading styles changed, check all route families for document-level horizontal overflow and serious/critical axe violations using the existing workspace test pattern. Internal table/grid scrolling is expected. Commit verified optional polish separately.

## Task 4: Final acceptance

- [ ] Run `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test`, and `npm.cmd run build`. After a shared layout change, run `npm.cmd run test:e2e`; for defaults-only changes, the focused suites in Task 1 plus updated staging smoke are the relevant browser checks.
- [ ] On the candidate build, confirm the four initial presets, manual overrides, review queue All time, historical import date behavior, and bidder financial restrictions. Confirm All time interviews load existing historical data with an honest loading/error state if the request fails.
- [ ] Inspect `git diff --check` and the final diff. Required application changes should remain three initializers; any additional production edits must correspond to a verified optional layout finding.
- [ ] Report the implemented defaults, optional layout changes actually made, commands/results, and any checks that could not run. Record new hosted results separately from prior release evidence. Deploy only as part of an implementation/release instruction, not this plan-writing request.

## Completion criteria

The required work is complete when fresh visits use the requested defaults, requests use the same selected periods, manual choices and existing workflow overrides still work, and relevant verification passes. Optional layout work is complete when reviewed pages have recorded outcomes and each applied improvement passes visual and interaction checks. Skipping optional polish does not block completion of the default-filter update.
