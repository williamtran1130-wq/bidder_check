// Bulk fixture setup only; the acceptance measurement code does not use this.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const STAGING = "https://kdmvludtvhuuewmhurpw.supabase.co";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMPS = new Set([
  "found_at",
  "applied_at",
  "first_applied_at",
  "deleted_at",
]);

const FINALIZATION_FIELDS = new Set([
  "review_status",
  "evidence_file_id",
  "applied",
  "application_method",
  "rate_cents",
  "applied_at",
  "first_applied_at",
  "deleted_at",
]);
const DIAGNOSTIC_FIELDS = new Set([
  "id",
  "workspace_id",
  "bidder_id",
  "resume_id",
  "company",
  "role_name",
  "url",
  "normalized_url",
  "source",
  "arrangement",
  "found_at",
  "review_status",
  "review_revision",
  ...FINALIZATION_FIELDS,
  "bid_id",
  "kind",
  "filename",
  "mime",
  "size_bytes",
  "storage_path",
  "sha256",
  "finalized",
  "created_by",
]);

function utc(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)
  )
    return value;
  // Remove only representation differences: UTC suffix and trailing zeroes.
  // Never truncate a nonzero fractional digit or parse/coerce other values.
  return value
    .replace(/\.(\d+)(?=Z|\+00:00$)/, (_, digits) => {
      const fraction = digits.replace(/0+$/, "");
      return fraction ? `.${fraction}` : "";
    })
    .replace(/\+00:00$/, "Z");
}

function mismatch() {
  throw Object.assign(
    new Error(
      "Seed acknowledgement could not be reconciled (details withheld)",
    ),
    { code: "SEED_RECONCILIATION_MISMATCH" },
  );
}

export async function seedChunk({
  service,
  receipt,
  table,
  operation,
  rows,
  check,
  save,
}) {
  const key =
    table === "bids" && operation === "insert"
      ? "bidsInsert"
      : table === "files" && operation === "insert"
        ? "filesInsert"
        : table === "bids" && operation === "upsert"
          ? "bidsUpsert"
          : null;
  assert.ok(key, "Unexpected bulk fixture operation");
  assert.equal(receipt.target, STAGING);
  assert.equal(receipt.started, true);
  assert.equal(receipt.phase, "seed");
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 500);
  const fields = Object.keys(rows[0]);
  assert.ok(fields.every((field) => /^[a-z][a-z0-9_]*$/.test(field)));
  const scope = new Set(receipt.workspaceIds);
  const actors = new Set(receipt.accounts.map((account) => account.id));
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  for (const row of rows) {
    assert.match(row.id, UUID);
    assert.ok(scope.has(row.workspace_id) && actors.has(row.bidder_id));
    if (table === "files") assert.ok(actors.has(row.created_by));
    assert.deepEqual(Object.keys(row).sort(), [...fields].sort());
    assert.ok(fields.every((field) => row[field] !== undefined));
  }
  const builder = service.from(table);
  const response = await (operation === "upsert"
    ? builder.upsert(rows, { onConflict: "id" })
    : builder.insert(rows));
  if (!response.error || response.status !== 0) return check(response);

  // A transport failure can lose the acknowledgement of a committed write.
  // Reconcile by scoped read only; a missing/partial result never causes retry.
  receipt.seedReconciliationCounts ??= {};
  const counts = (receipt.seedReconciliationCounts[key] ??= {
    attemptedChunks: 0,
    verifiedChunks: 0,
    verifiedRows: 0,
  });
  counts.attemptedChunks++;
  await save();
  const passes = key === "bidsUpsert" ? 3 : 1;
  for (let pass = 1; pass <= passes; pass++) {
    let disagreement;
    let actualRows = 0;
    const diagnostic = (reason, field) => {
      receipt.seedReconciliationDiagnostics ??= [];
      receipt.seedReconciliationDiagnostics.push({
        operation: key,
        pass,
        reason,
        ...(DIAGNOSTIC_FIELDS.has(field) ? { field } : {}),
        expectedRows: rows.length,
        actualRows,
      });
      // Bound setup-only diagnostics; never record IDs, values or error text.
      if (receipt.seedReconciliationDiagnostics.length > 3)
        receipt.seedReconciliationDiagnostics.shift();
    };
    const fail = async (reason, field) => {
      diagnostic(reason, field);
      await save();
      mismatch();
    };
    // Every pass starts at the original first ID slice. Matching rows from a
    // previous pass are never retained or used to complete this one.
    for (let start = 0; start < rows.length; start += 100) {
      const planned = rows.slice(start, start + 100);
      const byId = new Map(planned.map((row) => [row.id, row]));
      let actual;
      try {
        actual = check(
          await service
            .from(table)
            .select(fields.join(","))
            .in(
              "id",
              planned.map((row) => row.id),
            )
            .in("workspace_id", [
              ...new Set(planned.map((row) => row.workspace_id)),
            ]),
        );
      } catch (error) {
        diagnostic("read_error");
        await save();
        throw error;
      }
      if (!Array.isArray(actual)) await fail("invalid_rows");
      actualRows += actual.length;
      const seen = new Set();
      for (const found of actual) {
        if (!found || typeof found !== "object" || Array.isArray(found))
          await fail("invalid_row");
        if (!Object.hasOwn(found, "id")) await fail("missing_field", "id");
        if (seen.has(found.id)) await fail("duplicate_id", "id");
        seen.add(found.id);
        const row = byId.get(found.id);
        if (!row) await fail("unplanned_id", "id");
        for (const field of fields) {
          if (!Object.hasOwn(found, field)) await fail("missing_field", field);
          const want = TIMESTAMPS.has(field) ? utc(row[field]) : row[field];
          const got = TIMESTAMPS.has(field) ? utc(found[field]) : found[field];
          if (!isDeepStrictEqual(got, want)) {
            if (key !== "bidsUpsert" || !FINALIZATION_FIELDS.has(field))
              await fail("field_value", field);
            disagreement ??= { reason: "field_value", field };
          }
        }
      }
      // Even a short result must have safe IDs and all immutable fields.
      if (actual.length !== planned.length) {
        if (key !== "bidsUpsert") await fail("row_count");
        disagreement ??= { reason: "row_count" };
      }
    }
    if (!disagreement) {
      diagnostic("matched");
      counts.verifiedChunks++;
      counts.verifiedRows += rows.length;
      await save();
      return;
    }
    diagnostic(disagreement.reason, disagreement.field);
    await save();
    if (pass === passes) mismatch();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
