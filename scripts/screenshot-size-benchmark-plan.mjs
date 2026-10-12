import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

export function assertFreshPlan(plan, validateReceipt, now = Date.now()) {
  validateReceipt(plan);
  const fields = [
    "version",
    "target",
    "marker",
    "mode",
    "createdAt",
    "updatedAt",
    "fixtureBids",
    "accounts",
    "workspaceIds",
    "results",
    "phase",
    "passed",
    "cleanupComplete",
  ];
  assert.ok(
    Object.keys(plan).length === fields.length &&
      Object.keys(plan).every((key) => fields.includes(key)),
    "Only an unused initial plan is accepted",
  );
  assert.equal(plan.mode, "after");
  assert.equal(plan.phase, "planned");
  assert.equal(plan.passed, false);
  assert.equal(plan.cleanupComplete, false);
  assert.equal(plan.workspaceIds.length, 0);
  assert.ok(Array.isArray(plan.results) && plan.results.length === 0);
  for (const actor of plan.accounts)
    assert.ok(
      Object.keys(actor).every((key) => ["label", "id", "email"].includes(key)),
    );
  const created = Date.parse(plan.createdAt);
  assert.ok(
    Number.isFinite(created) &&
      new Date(created).toISOString() === plan.createdAt,
  );
  assert.ok(
    now - created >= 0 && now - created <= 60 * 60 * 1000,
    "Plan must be newly created within one hour",
  );
}
export async function verifyUnusedPlan(service, plan, check) {
  const ids = plan.accounts.map((actor) => actor.id);
  const emails = plan.accounts.map((actor) => actor.email);
  for (const id of ids) {
    const response = await service.auth.admin.getUserById(id);
    assert.ok(
      response.error &&
        (response.error.status === 404 ||
          response.error.code === "user_not_found"),
      "Plan identity already exists or cannot be proven absent; use guarded recovery",
    );
  }
  for (const [table, column, values] of [
    ["profiles", "id", ids],
    ["profiles", "email", emails],
    ["workspaces", "owner_id", ids],
    ["client_provisions", "id", ids],
    ["client_provisions", "email", emails],
  ]) {
    const rows = check(
      await service.from(table).select("id").in(column, values),
    );
    assert.ok(
      Array.isArray(rows) && rows.length === 0,
      "Plan scope already exists; use guarded recovery",
    );
  }
}
export async function claimPlan(receiptPath, bytes) {
  const handle = await open(`${receiptPath}.used`, "wx", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({
        planSha256: createHash("sha256").update(bytes).digest("hex"),
        claimedAt: new Date().toISOString(),
      }),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}
