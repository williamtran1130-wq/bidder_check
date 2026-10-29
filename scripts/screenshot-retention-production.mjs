// Production-only operator helper. No secrets, customer rows, or file paths are printed.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect } from "@playwright/test";

const url = "https://aizorlyfggwbewetnwqm.supabase.co";
const origin = "https://bidder-check.vercel.app";
assert.equal(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  url,
  "Production project required",
);
assert.ok(process.env.SUPABASE_SECRET_KEY, "Server credential required");
const mode = process.argv[2];
assert.ok(
  ["--status", "--activate", "--pause", "--drain", "--smoke"].includes(mode),
  "Choose an explicit operator mode",
);
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY, options);
const ok = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
const actorClient = () =>
  createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, options);
async function worker() {
  assert.ok(process.env.CRON_SECRET, "Worker credential required");
  const result = await fetch(`${origin}/api/cron/storage-cleanup`, {
    redirect: "manual",
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(65000),
  });
  assert.equal(
    result.status,
    200,
    "Production cleanup worker must return 200 JSON",
  );
  assert.match(result.headers.get("content-type") ?? "", /application\/json/);
  return result.json();
}
async function status() {
  const settings = ok(
    await admin.from("file_retention_settings").select("enabled").single(),
  );
  const count = async (table, filter) => {
    let query = admin.from(table).select("id", { count: "exact", head: true });
    if (filter) query = filter(query);
    const result = await query;
    ok(result);
    return result.count;
  };
  return {
    enabled: settings.enabled,
    expiredScreenshots: await count("files", (q) =>
      q
        .eq("kind", "screenshot")
        .eq("finalized", true)
        .lte(
          "finalized_at",
          new Date(Date.now() - 168 * 3600000).toISOString(),
        ),
    ),
    archivedProfiles: await count("candidate_profiles", (q) =>
      q.eq("archived", true),
    ),
    archivedAssignments: await count("resumes", (q) => q.eq("archived", true)),
    trashedBids: await count("bids", (q) => q.not("deleted_at", "is", null)),
    pendingFiles: await count("storage_cleanup_tasks", (q) =>
      q.is("completed_at", null),
    ),
    failedFiles: await count("storage_cleanup_tasks", (q) =>
      q.is("completed_at", null).not("last_error", "is", null),
    ),
  };
}
async function smoke() {
  const checks = [],
    users = [],
    clients = [],
    paths = [];
  const password = `Smoke-${randomUUID()}!`,
    prefix = `retention-${randomUUID()}`;
  let browser, workspace, profile, manager;
  const png = readFileSync(
    new URL("../tests/fixtures/screenshot-size-proof.png", import.meta.url),
  );
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  async function account(name, role) {
    const email = `${prefix}-${name}@example.com`;
    const user = ok(
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: "Retention verification" },
      }),
    ).user;
    users.push(user.id);
    if (role === "bidder")
      ok(await admin.from("workspaces").delete().eq("owner_id", user.id));
    ok(
      await admin
        .from("profiles")
        .update({ role, approval_status: "approved" })
        .eq("id", user.id),
    );
    const client = actorClient();
    clients.push(client);
    ok(await client.auth.signInWithPassword({ email, password }));
    return { id: user.id, email, client };
  }
  async function upload(actor, kind, target, bytes) {
    const id = ok(
      await actor.client.rpc("prepare_file", {
        p_kind: kind,
        p_target: target,
        p_name: kind === "resume" ? "resume.pdf" : "proof.png",
        p_mime: kind === "resume" ? "application/pdf" : "image/png",
        p_size: bytes.length,
      }),
    );
    const file = ok(
      await admin.from("files").select("*").eq("id", id).single(),
    );
    paths.push(file.storage_path);
    ok(
      await actor.client.storage
        .from("private-files")
        .upload(file.storage_path, bytes, { contentType: file.mime }),
    );
    ok(
      await admin.rpc("finalize_verified_file_v2", {
        p_id: id,
        p_sha: hash(bytes),
        p_actor: actor.id,
        p_context: { source: "unavailable", status: "unavailable" },
      }),
    );
    return file;
  }
  try {
    manager = await account("manager", "client");
    workspace = ok(
      await admin
        .from("workspaces")
        .select("id")
        .eq("owner_id", manager.id)
        .single(),
    ).id;
    const bidder = await account("bidder", "bidder"),
      peer = await account("peer", "bidder");
    for (const user of [bidder, peer])
      ok(
        await admin
          .from("bidders")
          .insert({
            user_id: user.id,
            workspace_id: workspace,
            default_rate_cents: 125,
          }),
      );
    profile = ok(
      await manager.client.rpc("save_candidate_profile", {
        p_id: null,
        p_workspace: workspace,
        p_identifier: prefix,
        p_name: "Synthetic retention candidate",
        p_address: "",
        p_links: "",
        p_instructions: "",
      }),
    );
    async function assignment(user) {
      const id = ok(
        await manager.client.rpc("save_resume_assignment", {
          p_id: null,
          p_profile: profile,
          p_bidder: user.id,
          p_email: user.email,
          p_phone: "555-0100",
          p_file: null,
          p_rate: null,
        }),
      );
      await upload(manager, "resume", id, pdf);
      return id;
    }
    const resume = await assignment(bidder),
      peerResume = await assignment(peer);
    const bid = ok(
      await manager.client.rpc("save_bid", {
        p_id: null,
        p_resume: resume,
        p_company: "Retention verification",
        p_role: "Engineer",
        p_url: `https://example.com/${prefix}`,
        p_source: "Verification",
        p_arrangement: "remote",
        p_status: "open",
      }),
    );
    await upload(bidder, "screenshot", bid, png);
    browser = await chromium.launch();
    async function login(user, onRequest) {
      const page = await browser.newPage();
      if (onRequest) page.on("request", onRequest);
      await page.goto(`${origin}/auth/login`);
      await page.getByLabel("Email address", { exact: true }).fill(user.email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page
        .getByRole("button", { name: "Sign in to workspace", exact: true })
        .click();
      await page.waitForURL(/\/dashboard/);
      await page.goto(`${origin}/bids`);
      return page;
    }
    let managerDownloads = 0;
    const managerPage = await login(manager, (request) => {
      if (request.url().includes("/storage/v1/object/sign/"))
        managerDownloads++;
    });
    await expect(
      managerPage.getByRole("button", {
        name: "Open screenshot for Retention verification",
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(managerDownloads, 0);
    await managerPage
      .getByRole("button", {
        name: "Open screenshot for Retention verification",
        exact: true,
      })
      .click();
    await expect(
      managerPage.getByRole("img", {
        name: "Enlarged application proof for Retention verification",
      }),
    ).toBeVisible();
    assert.equal(managerDownloads, 1);
    checks.push("manager preview is explicit");
    await managerPage.close();
    let bidderDownloads = 0;
    const bidderPage = await login(bidder, (request) => {
      if (request.url().includes("/storage/v1/object/sign/")) bidderDownloads++;
    });
    await expect(
      bidderPage.getByRole("button", { name: /Open screenshot/ }),
    ).toHaveCount(0);
    await bidderPage
      .getByRole("button", { name: "Replace screenshot", exact: true })
      .click();
    await bidderPage
      .getByLabel("Choose screenshot", { exact: true })
      .setInputFiles(
        new URL(
          "../tests/fixtures/screenshot-size-proof.png",
          import.meta.url,
        ).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      );
    await expect(
      bidderPage.getByText("Screenshot uploaded", { exact: true }),
    ).toBeVisible({ timeout: 45000 });
    assert.equal(bidderDownloads, 0);
    checks.push("bidder real upload has no preview download");
    await bidderPage.close();
    const currentProof = ok(await admin.from("bids").select("evidence_file_id").eq("id", bid).single()).evidence_file_id;
    paths.push(ok(await admin.from("files").select("storage_path").eq("id", currentProof).single()).storage_path);
    const before = ok(
      await admin
        .from("bids")
        .select(
          "applied,applied_at,first_applied_at,rate_cents,application_method",
        )
        .eq("id", bid)
        .single(),
    );
    const enabled = ok(
      await admin.from("file_retention_settings").select("enabled").single(),
    ).enabled;
    if (enabled) {
      // Only the synthetic proof is aged. Immutable timestamps of customer files are never edited.
      const id = randomUUID(),
        path = `${workspace}/${bidder.id}/${id}`;
      paths.push(path);
      ok(
        await admin
          .from("files")
          .insert({
            id,
            workspace_id: workspace,
            bidder_id: bidder.id,
            kind: "screenshot",
            bid_id: bid,
            filename: "expired.png",
            mime: "image/png",
            size_bytes: png.length,
            storage_path: path,
            created_by: bidder.id,
            finalized: true,
            finalized_at: new Date(Date.now() - 169 * 3600000).toISOString(),
            sha256: hash(png),
            review_revision: 1,
          }),
      );
      ok(
        await admin.storage
          .from("private-files")
          .upload(path, png, { contentType: "image/png" }),
      );
      ok(
        await admin.from("bids").update({ evidence_file_id: id }).eq("id", bid),
      );
      assert.ok(
        (
          await bidder.client.storage
            .from("private-files")
            .createSignedUrl(path, 60)
        ).error,
        "Expired direct Storage signing is denied",
      );
      await worker();
      assert.deepEqual(
        ok(
          await admin
            .from("bids")
            .select(
              "applied,applied_at,first_applied_at,rate_cents,application_method",
            )
            .eq("id", bid)
            .single(),
        ),
        before,
      );
      assert.equal(
        ok(
          await admin
            .from("bids")
            .select("evidence_file_id")
            .eq("id", bid)
            .single(),
        ).evidence_file_id,
        null,
      );
      checks.push("expiry preserves application and denies access");
    }
    ok(await manager.client.rpc("delete_resume_assignment", { p_id: resume }));
    assert.ok(
      ok(
        await admin.from("resumes").select("id").eq("id", peerResume).single(),
      ),
    );
    assert.ok(
      ok(
        await admin
          .from("candidate_profiles")
          .select("id")
          .eq("id", profile)
          .single(),
      ),
    );
    checks.push("assignment deletion preserves shared profile and peer");
    ok(
      await manager.client.rpc("delete_candidate_profile", {
        p_profile: profile,
      }),
    );
    profile = null;
    assert.equal(
      ok(await admin.from("resumes").select("id").eq("id", peerResume)).length,
      0,
    );
    checks.push("profile deletion removes dependent library records");
    await worker();
    for (const path of paths) {
      const exists = await admin.storage.from("private-files").exists(path);
      if (exists.error) throw new Error("Storage absence check failed");
      assert.equal(
        exists.data,
        false,
        "Deleted synthetic object must be absent",
      );
    }
    checks.push("physical object absence verified without image downloads");
    return {
      passed: checks,
      syntheticAccounts: users.length,
      expiryActive: enabled,
    };
  } finally {
    await browser?.close();
    if (workspace) {
      const remaining = ok(await admin.from("files").select("storage_path").eq("workspace_id", workspace));
      const pending = ok(await admin.from("storage_cleanup_tasks").select("storage_path").like("storage_path", `${workspace}/%`));
      for (const file of [...remaining,...pending]) if (file.storage_path && !paths.includes(file.storage_path)) paths.push(file.storage_path);
    }
    if (profile && manager)
      ok(
        await manager.client.rpc("delete_candidate_profile", {
          p_profile: profile,
        }),
      );
    // Exact generated paths only, after every synthetic upload has settled.
    if (paths.length) {
      ok(await admin.storage.from("private-files").remove(paths));
      ok(
        await admin
          .from("storage_cleanup_tasks")
          .delete()
          .in("storage_path", paths),
      );
    }
    for (const id of users) {
      ok(await admin.from("bid_purge_operations").delete().eq("actor_id", id));
      ok(await admin.from("bid_import_receipts").delete().eq("actor_id", id));
      ok(await admin.from("bidders").delete().eq("user_id", id));
    }
    for (const id of users) {
      ok(await admin.from("workspaces").delete().eq("owner_id", id));
    }
    for (const id of users) {
      ok(await admin.from("profiles").delete().eq("id", id));
      ok(await admin.auth.admin.deleteUser(id));
    }
    for (const client of clients) await client.auth.signOut({ scope: "local" });
  }
}

if (mode === "--status") console.log(JSON.stringify(await status()));
else if (mode === "--activate" || mode === "--pause") {
  ok(
    await admin
      .from("file_retention_settings")
      .update({ enabled: mode === "--activate" })
      .eq("singleton", true),
  );
  console.log(JSON.stringify(await status()));
} else if (mode === "--drain") {
  for (let pass = 0; pass < 20; pass++) {
    console.log(JSON.stringify({ pass: pass + 1, result: await worker() }));
    const current = await status();
    if (
      !current.expiredScreenshots &&
      !current.archivedProfiles &&
      !current.archivedAssignments &&
      !current.trashedBids
    )
      break;
  }
  console.log(JSON.stringify(await status()));
} else console.log(JSON.stringify(await smoke()));
