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
  for (let start = 0; start < rows.length; start += 100) {
    const planned = rows.slice(start, start + 100);
    const actual = check(
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
    if (!Array.isArray(actual) || actual.length !== planned.length) mismatch();
    const byId = new Map(actual.map((row) => [row.id, row]));
    if (byId.size !== planned.length) mismatch();
    for (const row of planned) {
      const found = byId.get(row.id);
      if (!found) mismatch();
      for (const field of fields) {
        if (!Object.hasOwn(found, field)) mismatch();
        const want = TIMESTAMPS.has(field) ? utc(row[field]) : row[field];
        const got = TIMESTAMPS.has(field) ? utc(found[field]) : found[field];
        if (!isDeepStrictEqual(got, want)) mismatch();
      }
    }
  }
  counts.verifiedChunks++;
  counts.verifiedRows += rows.length;
  await save();
}
