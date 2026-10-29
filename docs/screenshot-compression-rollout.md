# New screenshot compression

## Behavior

`SCREENSHOT_COMPRESSION_ENABLED=true` enables server-side compression for new
screenshots only. The flag defaults off; it is never a public browser variable.
The implementation uses the existing direct-to-Storage upload and caller-JWT
verification download, then Sharp WebP quality 90, alpha quality 100, effort 4.
There is no resizing. EXIF orientation is applied and unnecessary metadata is
stripped. A valid original remains the retained artifact if encoding fails or
does not save bytes. PDFs do not enter compression.

Original filename, MIME, byte size and SHA-256 remain proof metadata. The retained
artifact uses `stored_size_bytes`, `stored_mime`, `stored_sha256` and `storage_path`.
Existing size badges still compare original upload sizes. A compressed file URL
reports a WebP filename and MIME, including when the flag is later disabled.

Candidates are reserved with durable cleanup before upload, at unique paths in
the same private workspace/bidder namespace. Candidate requests have a 15-second
network budget; abandoned cleanup starts after ten minutes. The worker retains
its five-minute second removal. Activation refuses any candidate cleanup that
has ever been claimed, and atomically commits proof/context, retained metadata,
candidate cleanup cancellation and original cleanup. Failed or uncertain
activation must never trigger an ad-hoc candidate deletion.

## Local review

Open [the comparison page](screenshot-compression-samples/index.html) in a browser.
The examples are synthetic, not production images. Toggle the source and retained
image at native resolution, checking small text, punctuation, URLs and numerals
in both light and dark interfaces. Human readability approval is still pending.

Regenerate with:

```powershell
node --experimental-strip-types scripts/screenshot-compression-samples.mjs
```

The recorded synthetic examples save 41.60%, 49.86% and 58.75%. These are measured
example savings, not production or monthly egress predictions. Retained dimensions
are 1280 x 860 for all examples. The checked-in summary records byte counts and
hashes. Platform font rendering can affect regenerated examples.

## Production approval gates

No production migration, deployment, activation, image backfill or cleanup was
performed for this implementation. The production sequence, after explicit
approval, is:

1. Review and apply forward migration
   `202610290003_screenshot_compression.sql`; do not rewrite earlier migrations.
2. Deploy the matching application with the flag absent or `false`. Read services
   select the added column even with compression off, so schema must precede app.
3. Obtain readability approval before changing the flag to `true`. Redeploy with
   the approved server environment setting; no automatic activation is included.
4. Verify a synthetic PNG upload, retained WebP decoding and MIME, original
   rejected-proof hash, original-size badges, manager preview, bidder denial,
   replacement, expiry and physical cleanup. Remove all synthetic fixtures.
5. Disable the flag and verify already compressed images remain readable, then
   restore the approved value. On an incident, leave the schema/new read code in
   place and disable future compression; do not roll back to a reader that serves
   original MIME for retained WebP bytes.

## Seven-day monitoring

Capture a UTC timestamp, billing-period bounds, live object bytes, original and
retained screenshot bytes, pending/failed cleanup counts, upload latency, and
daily uncached/cached egress separately each day. Use the updated read-only
`supabase/operations/screenshot-compression-inventory.sql` after migration. Check
that no finalized-object size mismatches or orphan objects remain after normal
queue processing. Expected pending candidate tasks can temporarily contribute
objects beyond the file-row total.

Aggregate `[screenshot-compression] finalized` logs contain input/retained bytes,
success/fallback counters and compression/finalization duration only; they omit
customer identities, paths, error details and signed URLs. The duration starts
after original download/validation, so measure full upload latency separately.
Counters describe successful calls, including concurrent retries, rather than
unique stored files. Use object inventory for authoritative retained-byte totals.

Storage billing usage is a period average and egress already served cannot be
reversed. Compression reduces future stored/viewed bytes; the original-size
verification download is still required. If service-level egress remains high,
obtain its breakdown before proposing a separate upload architecture change.

## Local verification result

All 837 unit/database tests in 87 files passed, along with 38 desktop/mobile
upload/preview/retention/size/egress browser tests (clean runner exit 0), lint,
typecheck, generated-type verification and production build. The new inventory
SQL also executed successfully against a disposable database with every local
migration applied. See [verification evidence](release-evidence/2026-10-29-compression.json).

Independent review found two race defects; both were reproduced with failing
tests and fixed before the final suite: finalization winning before a second
request reserves, and deletion accelerating an already scheduled second removal.
PGlite verifies SQL/RLS and cleanup interleavings; separate simultaneous hosted
PostgreSQL sessions were not used. Full hosted synthetic acceptance remains part
of the approved production rollout, not this local implementation.
