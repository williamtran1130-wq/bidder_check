# Bidder Check

A Next.js + Supabase workspace for clients, bidders, resume profiles, applications, and USD earnings. UI uses shadcn/ui and Aceternity Background Beams.

## Run locally

Use Node 22 LTS and npm. On Windows use `npm.cmd` / `npx.cmd` if PowerShell blocks npm scripts.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Fill `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `APP_URL`. Never expose the secret with a `NEXT_PUBLIC_` prefix. It is used only for Auth administration and server-verified file finalization. Ordinary data reads, mutations, uploads and downloads use the user's JWT and RLS.

## Supabase setup

For a fresh database, apply all checked-in migrations in order using the Supabase CLI (`supabase login`, `supabase link --project-ref YOUR_REF`, `supabase db push`). For an existing deployment, follow the [reporting rollout procedure](docs/reliable-reporting-rollout.md): migrations 001–003, compatible application, then enforcement migration 004. Do not apply all four before the application upgrade. The initial migration requires an empty application schema. Production is `aizorlyfggwbewetnwqm`; isolated staging is `kdmvludtvhuuewmhurpw`. Never apply production migrations as part of the Vercel build.

Email confirmation is disabled, as requested. Client registration immediately creates a signed-in session with pending approval. Until an admin approves, clients can only view their approval status, change their password, or sign out. Existing clients are grandfathered as approved. SMTP is not required. In Users, clients/admins add a bidder by name and email, with initial password `123456`. Bidders can change their password through Settings → Change password (new passwords require 8–128 characters). Share initial credentials directly. Forgotten-password guidance directs users to their client/administrator; no recovery email is sent.

Bidder creation first reserves the email under the signed-in manager's database permissions, then uses server-only Auth administration to create the account with the reserved UUID. Public signup cannot select an Auth user ID or consume this reservation; editable signup metadata cannot assign roles. The legacy `invitations` table stores these account-creation reservations, and failed creation can be retried from Unfinished account creation. An email cannot belong to multiple clients or roles. Removing users archives them and preserves history; archived clients also block their bidders. Admins manage expandable Client ? Bidders groups and approve/reject registrations. Clients manage their own bidders. Names, email addresses, rates, archival/restoration and explicitly confirmed password resets are available in Manage. Managed resets use `123456` and send no email. Auth email edits synchronize profiles and provisioning reservations in one database transaction.

Set each environment's Site URL to its deployed origin. Preview uses staging credentials, never production. Do not push the local `supabase/config.toml` unchanged to production because its Site URL is localhost.

Register the designated administrator, then run the explicit bootstrap:

```sh
npm run admin:bootstrap -- david.chan.mdev@gmail.com
```

The script refuses unknown, unconfirmed, and bidder accounts. With email confirmation disabled, Supabase confirms new accounts automatically. It does not use a first-user administrator shortcut. `david.chan.mdev@gmail.com` has already been bootstrapped in production.

## Earnings and evidence

Earnings and rates are available only to clients and admins. Bidders retain application and interview statistics, with financial columns excluded from their API payloads and direct database reads. Manager values are loaded through an authorized, bounded financial-values RPC; historical rates and internal audit details remain stored.

The first application records the effective rate (resume override or bidder default) and its reporting timestamp. A successful screenshot upload applies the bid automatically. Applied bids with verified evidence count once. Replacing proof updates the displayed application time while preserving the first earning date and rate. Trashed bids are recoverable and excluded from lists, counts and earnings; restoration reinstates their prior state once. Corrections remove earnings; reapplication requires a screenshot whose SHA-256 differs from all rejected screenshots for that bid, restoring the original rate and reporting date. All transitions lock the bid row. Private objects cannot be overwritten by users. The server downloads the actual uploaded bytes under the caller's JWT, checks size and file signature, fully decodes screenshots, then atomically finalizes the file and application using a narrowly scoped privileged function. Signed download links expire after 60 seconds.

## Daily bid workflow

Normal Add bid assigns Found time in PostgreSQL; existing dates cannot be edited. Imports can assign a historical CT date. Found and latest Applied timestamps display in America/Chicago (CT), including DST. Shared filters offer Today, Yesterday, This week, Last week, This month, Last month, All time and Custom range. Weeks start Monday; current weeks/months end today. Bids default to Today, Overview and Earnings to This week, and Interview performance to All time. Relative periods refresh at CT midnight and on focus, deferring changes during active bid editing. The recoverable Trash view and a separate filtered query keep table dates independent from reports. Private screenshot thumbnails load for visible rows, refresh their short-lived URLs, and open an enlarged viewer. Inline uploads support selection, drag/drop, paste, progress and retry.

The dashboard shows a focused activity overview and found-versus-applied comparisons from the same found-date cohort. Managers see bidder and profile comparisons; bidders see their own profiles. Each comparison splits Found and Applied into Remote and Onsite/hybrid, with Unspecified for older retained history whose arrangement was not recorded. Live records use their current arrangement; future retention preserves the arrangement at cleanup. All time totals include retained history, while chart buckets stay bounded. Bid creation and editing live in Bid workspace. Reporting failures show an unavailable/retry state; only results for the same filters can remain visible. See [reporting diagnostics and hosted verification limits](docs/reporting-performance.md).

New workspaces default to `Workspace - {owner display name}`. Migration `202610120007` replaces every existing workspace name, including custom names, while retaining a private rollback map. Later display-name edits and workspace renames remain independent. See the [arrangement reporting and workspace naming rollout](docs/overview-arrangements-rollout.md) for migration order and guarded recovery.

## Spreadsheet editing and Sheets imports

Click a cell to select it; double-click, Enter or F2 edits supported fields. Enter, Tab or leaving the editor saves; Escape cancels. Arrow keys navigate, and Shift-arrow, Shift-click or dragging selects a rectangle on the current page. Ctrl/Cmd+C copies the range as TSV, including complete job URLs and bidder IDs. Read-only dates, ownership, application status and evidence retain their existing controls. Conflicting edits show the latest database value alongside the retained draft.

**Paste from Sheets** creates new bids only. Choose one bidder, resume and CT Added date, paste cells and map columns. Preview rows are read-only and show Checking, Allowed or Blocked. Return to mapping/source to make corrections. Blocked rows are automatically excluded with no reason text, skipped-row report or skipped-count notice. Completion shows the added count; an all-blocked batch shows No bids to add. The optional header checkbox starts off. Shared defaults fill blank mapped cells. Limits are 500 rows and 512 KiB of clipboard text; mapped JSON has a 2 MiB limit to accommodate escaping/defaults. Formula-like strings remain plain values in the app. Backend validation enforces active-only duplicate reservations and profile/company rules under a profile lock. Submission intersects freshly eligible rows with the approved preview. Actor-scoped request receipts, including completed zero-row results, preserve retries after a lost response. Today gets the server timestamp; historical days use Chicago midnight. Expected single-bid eligibility rejection shows only Blocked; ordinary validation and connection failures remain distinct.

`update_bid_cell` checks the expected version and records audit history. `validate_bid_import` and `import_bids` independently enforce role/ownership, fields, duplicates and dates. Import receipts remain private to their actor and accessible workspace.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Database tests execute all migrations in PGlite PostgreSQL with test equivalents of Supabase's Auth and Storage schemas and `auth.uid()`. They exercise RLS with an `authenticated` database role. Hosted Auth and Storage HTTP are checked separately by `scripts/hosted-smoke.mjs`.

Browser tests exercise real authentication pages and the workspace components using synthetic fixtures in an isolated Vite server (`tests/preview`). Fixture handlers simulate cell edits and validation only; other writes remain disabled. This verifies layout, filters, navigation, theme changes and accessibility; it does not replace a hosted authenticated workflow test. The production app never serves these fixtures. On restricted Windows hosts, browser tests may need permission to stop their own server processes.

`node scripts/generate-types.mjs` generates TypeScript types from the executable migration without Docker. After a local Supabase startup, `npm run db:types` can regenerate from the live schema.

For real staging workflows, set staging keys in ignored `.env.staging`, run the application against those credentials on port 3002, then run `node --env-file=.env.staging scripts/hosted-smoke.mjs`. `SMOKE_APP_URL` can target the deployed staging app; protected previews also need `SMOKE_VERCEL_BYPASS`. The script refuses the production database, creates synthetic accounts, and removes its own accounts/files afterward. Reports are saved in ignored `test-results/`.

After staging migrations are ready, `node --env-file=.env.staging scripts/reporting-staging-benchmark.mjs --staging-ready` verifies 25,000 synthetic bids with five concurrent authenticated readers and removes its fixtures. Run it separately from the full hosted workflow suite. After production financial enforcement, `node --env-file=.env.local scripts/reporting-production-smoke.mjs --production-read-only` checks live reporting, dashboard/interview pages and financial restrictions using temporary, no-email sessions for existing accounts. It does not edit customer applications and signs out only its own verification sessions.

## Vercel

Import `DevTech06130324/bidder-check`, select Next.js, root `./`, build `npm run build`, default output directory, Node 22. Add the four environment variables separately to Production and Preview. Use isolated staging Supabase for Preview. Set `APP_URL` to the corresponding trusted origin. Follow the phased migration/application rollout above. Production branch is `main`.

Before launch verify: pending client signup, admin approval/rejection, account email edits/password resets, bidder creation/default-password login/password change, tenant isolation with two clients, resume download, screenshot upload/application, client correction/reapplication, and admin reporting. Check Vercel runtime logs without logging personal profile fields or file contents. Roll back application deployments through Vercel; database migrations require separately reviewed forward fixes.

Paid templates, scraping, job auto-apply, payroll, and payment transfers are outside this release.
