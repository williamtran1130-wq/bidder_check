# Bidder sign-out and password management

Production release: 2026-11-02, application source `9f4313e`, deployment
`dpl_FyEcFqRyxmLDFKVmzkkyNdu73MWD` at https://bidder-check.vercel.app.
Migration `202611020001` and the sensitive production HMAC setting are installed.
Real hosted multi-browser Auth, refresh-token and private Storage acceptance passed
against this exact deployment before promotion. All three synthetic accounts and
their private file were removed; the profile inventory returned to its original
38 records. The former staging projects have been removed, so this release used
an isolated production-target candidate without domain promotion for acceptance.
See [release evidence](release-evidence/2026-11-02-bidder-security-production.json).

Clients manage their own bidders from **People → Manage** or the bidder detail
page. Administrators can manage all bidders. **Sign out all devices** ends current
sessions but permits another sign-in. **Change password** accepts an exact match
of 8–128 characters and ends current sessions as part of the accepted Auth change.
Passwords are shared directly; this feature sends no email.

## Deployment

1. Configure `MANAGED_PASSWORD_HMAC_KEY` on the server with 32 random bytes encoded
   as 64 hexadecimal characters. Generate it with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Keep it out of client environment variables, source control and logs. Retain
   the same key across replicas and deployments while password requests are
   pending. An incorrect or missing key disables custom password submission;
   it does not disable sign-out or completion of already accepted changes.

2. Apply `202611020001_bidder_security.sql` in staging and deploy the application.
   It uses the standard Auth `sessions(id,user_id)` and
   `refresh_tokens(user_id,session_id)` tables. Session cleanup explicitly deletes
   the bidder's refresh credentials rather than depending only on cascade rules.
   No application role receives read or write access to Auth tables.

3. The migration installs `public.enforce_live_session` as
   `authenticator`'s `pgrst.db_pre_request` hook and reloads PostgREST configuration.
   An existing different role-level hook causes migration failure; compose that
   hook with this check explicitly instead of dropping existing protections.
   Check for database-specific hook overrides as part of staging validation.

4. Run the real local integration test below, then repeat the two-browser
   sign-out/password smoke test in staging. Verify that direct Data API reads and
   RPCs reject an old token with `PT401`, refresh fails, authenticated Storage
   access is blocked, and other accounts continue working. Only then roll out
   the migration, stable key and application together to production.

## Recovery and compatibility

Managed changes retain the existing journal, request identity, target reservation,
dispatch lease and transaction receipt. Only one unfinished operation may target
an account. Resolve an earlier operation through **Pending account changes**
before starting another.

Passwords stay in form/server memory and are never saved in browser storage,
journal payloads, app metadata, audit records or action responses. The private
journal stores an HMAC commitment bound to the request, target and exact password.
Its public recovery view excludes that commitment. Recovery without an accepted
Auth receipt asks the original manager to enter the original password again.
If a request never reached the server, the same saved identity can be used to
submit it after an authenticated absence check. Wrong or invalid re-entry never
discards the saved identity. Accepted requests can finish without the password.

Password acceptance revokes sessions within the Auth transaction. Finishing or
replaying the journal cannot revoke sessions created afterward. Sign-out and its
audit event commit together and likewise replay without a second revocation.
New fixed `123456` resets are rejected for bidders; already journaled bidder
resets and administrator-managed client resets remain recoverable. Bidder account
creation retains its existing initial-password behavior.

Revocation is enforced on the next authenticated app, Data API or Storage request.
The app does not poll idle pages or erase information already downloaded. Signed
file links issued before revocation retain their original expiry. Anonymous/public
requests and trusted service-role workers retain their existing behavior.
Session-verification outages fail closed without falsely declaring sign-out.

## Verification

```powershell
npm.cmd test
node scripts/generate-types.mjs --check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:bidder-security:e2e
```

The UI suite tests the real Manage dialog on desktop/mobile with an isolated
provider fixture; the database suite tests real migrations, authorization,
Storage policies, transaction rollback, dispatch fencing and session deletion.

The integration test uses real Supabase Auth and multiple independent browser
contexts. It creates and removes only its own account fixtures. It intentionally
refuses hosted Supabase and database URLs and is skipped unless explicitly enabled.

Start a disposable local Supabase stack, apply all repository migrations, and set
these environment variables from that instance's local credentials:

- `BIDDER_SECURITY_INTEGRATION=1`
- `BIDDER_SECURITY_SUPABASE_URL` — local API URL
- `BIDDER_SECURITY_PUBLISHABLE_KEY` — local public/anon key
- `BIDDER_SECURITY_SECRET_KEY` — local secret/service-role key
- `BIDDER_SECURITY_DATABASE_URL` — local PostgreSQL connection URL

Then run `npm.cmd run test:bidder-security:integration`. Its config starts a separate
Next.js dev server on port 3103 with the local keys and a test-only HMAC key.
It checks real browser redirects, direct API rejection, refresh-token cleanup,
old/new password behavior, secret-free journal storage and unaffected sessions.
Do not enable production rollout based solely on the fixture tests.
