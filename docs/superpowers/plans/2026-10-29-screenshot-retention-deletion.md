# Screenshot retention and permanent deletion

Approved specification: the implementation plan supplied in the 2026-10-29 conversation.

1. Separate seven-day screenshot expiry from application state; preserve proof rejection, earnings and monthly retention.
2. Show bidder upload status only; manager screenshot downloads happen only on explicit open.
3. Permanently delete bids and candidate-library records with authorized, version-checked RPCs; accounts retain deactivation.
4. Reuse retryable Storage cleanup, erase completed operational records, clean legacy archives/superseded files, and fix scheduler discovery.
5. Verify locally and deploy compatible migrations/application directly to production before activating destructive cleanup.

Constraints: no staging, no global reset, no historical migration edits, preserve unrelated files. Storage errors must remain retryable. Keep active-bid activity, remove deleted-file links and obsolete upload contexts. Minimal request replay protection remains. Abandoned uploads expire after 24 hours; current resume PDFs do not expire.

Verification: new regression tests first; generated types, lint, typecheck, full unit/database and browser suites, production build; production synthetic lifecycle and read-only real-data counts. Production activation must remain off until the compatible deployment is confirmed.
